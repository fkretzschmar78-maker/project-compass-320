import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";

import { getDeepgramToken } from "@/lib/deepgram.functions";
import { translateText } from "@/lib/translate.functions";
import { synthesizeSpeech } from "@/lib/tts.functions";
import { logConversationSegment } from "@/lib/conversation-log.functions";
import { setMyLanguage, getSessionLanguages } from "@/lib/session-language.functions";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import type { LanguageCode } from "@/lib/languages";
import { useRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

export const Route = createFileRoute("/_authenticated/transcribe")({
  head: () => ({
    meta: [
      { title: "Live-Spracherkennung" },
      {
        name: "description",
        content:
          "Live-Spracherkennung für Ärzte und Patienten über Deepgram mit sofortigem Transkript.",
      },
      { property: "og:title", content: "Live-Spracherkennung" },
      {
        property: "og:description",
        content:
          "Sofortige Spracherkennung für Ärzte und Patienten über Deepgram.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TranscribePage,
});

const ROLE_LABEL: Record<string, string> = {
  arzt: "Arzt",
  patient: "Patient",
  spectator: "Zuhörer",
};

const LIVE_CHANNEL = "medifluent-live";

const OTHER_ROLE: Record<string, "arzt" | "patient"> = {
  arzt: "patient",
  patient: "arzt",
};

interface TranscriptItem {
  id: string;
  text: string;
  isFinal: boolean;
  translation?: string;
  translating?: boolean;
  translationError?: string;
  backTranslation?: string;
  backTranslating?: boolean;
  backTranslationError?: string;
  audioClips?: string[];
  synthesizing?: boolean;
  synthesisError?: string;
  finalAt?: number;
  translationReceivedAt?: number;
  ttsReceivedAt?: number;
}

interface LiveSegment {
  id: string;
  fromRole: "arzt" | "patient";
  originalText: string;
  translatedText: string;
}

interface ReleasedAkte {
  anamnese: string;
  befund: string;
  beurteilung: string;
  prozedere: string;
}

function TranscribePage() {
  const { data: roleData, isLoading: roleLoading } = useRole();
  const role = roleData?.role;
  const fetchTranslate = useServerFn(translateText);
  const fetchSynthesize = useServerFn(synthesizeSpeech);
  const fetchLogSegment = useServerFn(logConversationSegment);
  const fetchSetMyLanguage = useServerFn(setMyLanguage);
  const fetchSessionLanguages = useServerFn(getSessionLanguages);

  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [receivedSegments, setReceivedSegments] = useState<string[]>([]);
  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
  const [releasedAkte, setReleasedAkte] = useState<ReleasedAkte | null>(null);
  const [lastBroadcastLatency, setLastBroadcastLatency] = useState<number | null>(null);
  const [myLanguage, setMyLanguageState] = useState<LanguageCode | null>(null);
  const [otherLanguage, setOtherLanguage] = useState<LanguageCode | null>(null);
  const [languageLoading, setLanguageLoading] = useState(true);
  const [languageSaving, setLanguageSaving] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioQueueRef = useRef<string[][]>([]);
  const isPlayingRef = useRef(false);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const languagesReadyRef = useRef(false);

  function enqueueClips(clips: string[]) {
    audioQueueRef.current.push(clips);
    void processQueue();
  }

  async function processQueue() {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    isPlayingRef.current = true;
    const clips = audioQueueRef.current.shift()!;
    await playClipArray(clips);
    isPlayingRef.current = false;
    void processQueue();
  }

  function playClipArray(clips: string[]): Promise<void> {
    return new Promise((resolve) => {
      let index = 0;
      const playNext = () => {
        if (index >= clips.length) {
          resolve();
          return;
        }
        const audio = new Audio(`data:audio/mp3;base64,${clips[index]}`);
        audio.onended = () => {
          index++;
          playNext();
        };
        audio.onerror = () => {
          console.error("Audio-Wiedergabe-Fehler");
          index++;
          playNext();
        };
        audio.play().catch((err) => {
          console.error("Audio.play() abgelehnt:", err);
          index++;
          playNext();
        });
      };
      playNext();
    });
  }

  useEffect(() => {
    return () => {
      void stop();
    };
  }, []);

  useEffect(() => {
    if (!role) return;

    const channel = supabase.channel(LIVE_CHANNEL, {
      config: { broadcast: { self: false } },
    });

    channel
      .on(
        "broadcast",
        { event: "speech" },
        (message: { payload?: BroadcastSpeechPayload }) => {
          const payload = message.payload;
          if (payload?.segmentId) {
            console.log(`[Latenz][${payload.segmentId}] Broadcast received: ${Date.now()}`);
          }
          if (!payload || !Array.isArray(payload.clips)) return;

          if (role === "spectator") {
            if (payload.clips.length > 0) {
              const segmentId = payload.segmentId || "unknown";
              setReceivedSegments((prev) => [...prev.slice(-2), segmentId]);
              enqueueClips(payload.clips);
            }
            if (payload.originalText && payload.translatedText) {
              setLiveSegments((prev) => [
                ...prev,
                {
                  id: payload.segmentId || crypto.randomUUID(),
                  fromRole: payload.fromRole,
                  originalText: payload.originalText,
                  translatedText: payload.translatedText,
                },
              ]);
            }
            return;
          }

          if (
            payload.clips.length > 0 &&
            payload.fromRole === OTHER_ROLE[role]
          ) {
            const segmentId = payload.segmentId || "unknown";
            setReceivedSegments((prev) => [...prev.slice(-2), segmentId]);
            enqueueClips(payload.clips);
          }
        },
      )
      .on(
        "broadcast",
        { event: "akte-freigegeben" },
        (message: { payload?: ReleasedAkte }) => {
          const payload = message.payload;
          if (
            payload &&
            typeof payload.anamnese === "string" &&
            typeof payload.befund === "string" &&
            typeof payload.beurteilung === "string" &&
            typeof payload.prozedere === "string"
          ) {
            setReleasedAkte(payload);
          }
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      void channel.unsubscribe();
      channelRef.current = null;
    };
  }, [role]);

  useEffect(() => {
    languagesReadyRef.current = !!(myLanguage && otherLanguage);
  }, [myLanguage, otherLanguage]);

  useEffect(() => {
    if (role !== "arzt" && role !== "patient") return;

    let mounted = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function loadLanguages() {
      try {
        const result = await fetchSessionLanguages({ data: undefined });
        if (!mounted) return;
        if (role === "arzt") {
          setMyLanguageState(result.arzt);
          setOtherLanguage(result.patient);
        } else {
          setMyLanguageState(result.patient);
          setOtherLanguage(result.arzt);
        }
      } catch (err) {
        console.error("Sprachen konnten nicht geladen werden", err);
      } finally {
        if (mounted) setLanguageLoading(false);
      }
    }

    void loadLanguages();

    intervalId = setInterval(() => {
      if (!languagesReadyRef.current) {
        void loadLanguages();
      }
    }, 3000);

    return () => {
      mounted = false;
      if (intervalId) clearInterval(intervalId);
    };
  }, [role]);

  if (roleLoading) {
    return (
      <main className="flex min-h-full items-center justify-center bg-app-background px-4 py-16">
        <p className="text-muted-foreground">Rolle wird geladen …</p>
      </main>
    );
  }

  if (!role) {
    return (
      <main className="flex min-h-full items-center justify-center bg-app-background px-4 py-16">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Spracherkennung nicht verfügbar</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Die Live-Spracherkennung steht nur Ärzten und Patienten zur
              Verfügung. Ihre aktuelle Rolle:{" "}
              <span className="font-medium text-foreground">unbekannt</span>.
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link to="/dashboard">Zurück zur Übersicht</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (role === "spectator") {
    return (
      <main className="flex min-h-full flex-col items-center bg-app-background px-4 py-16">
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <CardTitle className="text-app-text">Live-Mitschrift</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <p className="text-sm text-app-text">
              Rolle:{" "}
              <span className="font-medium">{ROLE_LABEL[role]}</span>
            </p>

            {releasedAkte && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-app-text">
                    Freigegebene Aktennotiz
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <AkteSection title="Anamnese" text={releasedAkte.anamnese} />
                  <AkteSection title="Befund" text={releasedAkte.befund} />
                  <AkteSection
                    title="Beurteilung"
                    text={releasedAkte.beurteilung}
                  />
                  <AkteSection title="Prozedere" text={releasedAkte.prozedere} />
                </CardContent>
              </Card>
            )}

            <div className="rounded-md border bg-muted/40 p-4">
              <p className="mb-2 text-sm font-medium text-app-text">
                Empfangene Segmente
              </p>
              <div className="space-y-6">
                {liveSegments.map((seg, i) => (
                  <div key={seg.id ?? i} className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {ROLE_LABEL[seg.fromRole]}
                    </p>
                    <p className="text-xl font-medium text-app-text">
                      {seg.originalText}
                    </p>
                    <p className="border-l-4 border-translation-accent pl-3 text-lg text-translation-accent">
                      {seg.translatedText}
                    </p>
                  </div>
                ))}
                {liveSegments.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Noch keine Segmente empfangen.
                  </p>
                )}
              </div>
            </div>

            <Button asChild variant="outline" className="w-full">
              <Link to="/dashboard">Zurück zur Übersicht</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  async function start() {
    setError(null);
    setIsRecording(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const audioContext = new AudioContext();
      audioCtxRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);

      const workletCode = `
        class Pcm16Processor extends AudioWorkletProcessor {
          constructor(options) {
            super();
            this.sourceSampleRate = options.processorOptions?.sourceSampleRate || 48000;
            this.targetSampleRate = 16000;
            this.ratio = this.sourceSampleRate / this.targetSampleRate;
            this.buffer = new Float32Array(0);
          }

          process(inputs, outputs, parameters) {
            const input = inputs[0];
            if (!input || !input[0]) return true;
            const channel = input[0];

            const combined = new Float32Array(this.buffer.length + channel.length);
            combined.set(this.buffer);
            combined.set(channel, this.buffer.length);

            const outLen = Math.floor(combined.length / this.ratio);
            if (outLen === 0) {
              this.buffer = combined;
              return true;
            }

            const out = new Int16Array(outLen);
            let phase = 0;
            for (let i = 0; i < outLen; i++) {
              const idx = Math.floor(phase);
              const frac = phase - idx;
              const a = combined[idx];
              const b = idx + 1 < combined.length ? combined[idx + 1] : a;
              const sample = a + (b - a) * frac;
              const clamped = Math.max(-1, Math.min(1, sample));
              out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
              phase += this.ratio;
            }

            const consumed = Math.floor(phase);
            this.buffer = consumed < combined.length
              ? combined.slice(consumed)
              : new Float32Array(0);

            this.port.postMessage(out, [out.buffer]);
            return true;
          }
        }

        registerProcessor("pcm16-processor", Pcm16Processor);
      `;

      const blob = new Blob([workletCode], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);

      try {
        await audioContext.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }

      const workletNode = new AudioWorkletNode(
        audioContext,
        "pcm16-processor",
        {
          processorOptions: { sourceSampleRate: audioContext.sampleRate },
        },
      );
      workletNodeRef.current = workletNode;

      const { token, language, listenUrl } = await getDeepgramToken({
        data: undefined,
      });
      if (!token) {
        throw new Error("Kein Deepgram-Token erhalten");
      }

      const wsUrl = new URL(listenUrl);
      wsUrl.searchParams.set("model", "nova-3");
      wsUrl.searchParams.set("language", language);
      wsUrl.searchParams.set("encoding", "linear16");
      wsUrl.searchParams.set("sample_rate", "16000");
      wsUrl.searchParams.set("endpointing", "300");

      // Authentifizierung gegen Deepgram per Sec-WebSocket-Protocol.
      const ws = new WebSocket(wsUrl.toString(), ["token", token]);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        source.connect(workletNode);
        workletNode.port.onmessage = (event) => {
          const int16 = event.data as Int16Array;
          if (ws.readyState === WebSocket.OPEN) {
            const buffer = new ArrayBuffer(int16.byteLength);
            new Int16Array(buffer).set(int16);
            ws.send(buffer);
          }
        };
      };

      ws.onmessage = (event) => {
        const raw = typeof event.data === "string" ? event.data : "";
        const msg = JSON.parse(raw) as DeepgramMessage;
        if (msg.type === "Results") {
          const transcript = msg.channel?.alternatives?.[0]?.transcript ?? "";
          if (!transcript) return;
          if (msg.is_final) {
            const id = crypto.randomUUID();
            const finalAt = Date.now();
            setTranscripts((prev) => {
              const last = prev[prev.length - 1];
              if (last && !last.isFinal) {
                return [
                  ...prev.slice(0, -1),
                  { id, text: transcript, isFinal: true, translating: true, finalAt },
                ];
              }
              return [
                ...prev,
                { id, text: transcript, isFinal: true, translating: true, finalAt },
              ];
            });
            if (role === "patient") {
              void fetchLogSegment({ data: { text: transcript } }).catch((err) =>
                console.error("Protokollierung fehlgeschlagen:", err),
              );
            }
            fetchTranslate({ data: { text: transcript } })
              .then((result) => {
                const translationReceivedAt = Date.now();
                setTranscripts((prev) =>
                  prev.map((item) =>
                    item.id === id
                      ? {
                          ...item,
                          translation: result.translation,
                          translating: false,
                          synthesizing: true,
                          backTranslating: true,
                          translationReceivedAt,
                        }
                      : item
                  )
                );
                    if (role === "arzt") {
                      void fetchLogSegment({
                        data: { text: result.translation },
                      }).catch((err) =>
                        console.error("Protokollierung fehlgeschlagen:", err),
                      );
                    }
                    fetchSynthesize({ data: { text: result.translation } })
                      .then((synthResult) => {
                        const ttsReceivedAt = Date.now();
                        setTranscripts((prev) =>
                          prev.map((item) =>
                            item.id === id
                              ? {
                                  ...item,
                                  audioClips: synthResult.clips,
                                  synthesizing: false,
                                  ttsReceivedAt,
                                }
                              : item
                          )
                        );
                        const channel = channelRef.current;
                        if (channel) {
                          console.log(`[Latenz][${id}] Broadcast sending: ${Date.now()}`);
                          void channel.send({
                            type: "broadcast",
                            event: "speech",
                            payload: {
                              clips: synthResult.clips,
                              fromRole: role,
                              segmentId: id,
                              originalText: transcript,
                              translatedText: result.translation,
                            } as BroadcastSpeechPayload,
                          });
                        }
                      })
                      .catch((err) => {
                        console.error("Sprachausgabe fehlgeschlagen:", err);
                        setTranscripts((prev) =>
                          prev.map((item) =>
                            item.id === id
                              ? {
                                  ...item,
                                  synthesisError: "Sprachausgabe fehlgeschlagen",
                                  synthesizing: false,
                                }
                              : item
                          )
                        );
                      });
                    // Rückübersetzung läuft parallel und blockiert TTS/Broadcast nicht.
                    fetchTranslate({ data: { text: result.translation, direction: "back" } })
                      .then((backResult) => {
                        setTranscripts((prev) =>
                          prev.map((item) =>
                            item.id === id
                              ? {
                                  ...item,
                                  backTranslation: backResult.translation,
                                  backTranslating: false,
                                }
                              : item
                          )
                        );
                      })
                      .catch((err) => {
                        console.error("Rückübersetzung fehlgeschlagen:", err);
                        setTranscripts((prev) =>
                          prev.map((item) =>
                            item.id === id
                              ? {
                                  ...item,
                                  backTranslationError: "Rückübersetzung fehlgeschlagen",
                                  backTranslating: false,
                                }
                              : item
                          )
                        );
                      });
                  })
              .catch((err) => {
                console.error("Übersetzung fehlgeschlagen:", err);
                setTranscripts((prev) =>
                  prev.map((item) =>
                    item.id === id
                      ? {
                          ...item,
                          translationError: "Übersetzung fehlgeschlagen",
                          translating: false,
                        }
                      : item
                  )
                );
              });
            return;
          }
          setTranscripts((prev) => {
            const last = prev[prev.length - 1];
            if (last && !last.isFinal) {
              return [...prev.slice(0, -1), { ...last, text: transcript }];
            }
            return [
              ...prev,
              { id: crypto.randomUUID(), text: transcript, isFinal: false },
            ];
          });
        }
      };

      const fail = (reason: string) => {
        if (wsRef.current !== ws) return;
        setError(reason);
        void stop();
      };

      ws.onerror = (event) => {
        console.error("WebSocket-Fehler", event);
      };

      ws.onclose = (event) => {
        const code = event.code;
        const reason = event.reason || "kein Grund angegeben";
        console.error("WebSocket geschlossen", { code, reason });
        fail(
          `Verbindung zur Spracherkennung wurde unterbrochen (Code ${code}: ${reason})`,
        );
      };
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Aufnahme konnte nicht gestartet werden",
      );
      void stop();
    }
  }

  async function stop() {
    const ctx = audioCtxRef.current;
    const worklet = workletNodeRef.current;
    const stream = mediaStreamRef.current;
    const ws = wsRef.current;

    wsRef.current = null;

    if (worklet) {
      try {
        worklet.port.postMessage("stop");
      } catch {
        // ignore
      }
      worklet.disconnect();
    }

    if (ctx && ctx.state !== "closed") {
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    }

    stream?.getTracks().forEach((track) => track.stop());

    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
        }
      } catch {
        // ignore
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
    }

    audioCtxRef.current = null;
    workletNodeRef.current = null;
    mediaStreamRef.current = null;
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    setIsRecording(false);
  }

  async function handleLanguageChange(code: LanguageCode) {
    setLanguageSaving(true);
    setError(null);
    try {
      await fetchSetMyLanguage({ data: { languageCode: code } });
      const result = await fetchSessionLanguages({ data: undefined });
      if (role === "arzt") {
        setMyLanguageState(result.arzt);
        setOtherLanguage(result.patient);
      } else {
        setMyLanguageState(result.patient);
        setOtherLanguage(result.arzt);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Sprache konnte nicht gespeichert werden",
      );
    } finally {
      setLanguageSaving(false);
    }
  }

  return (
    <main className="flex min-h-full flex-col items-center bg-app-background px-4 py-16">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-app-text">Live-Spracherkennung</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-sm text-app-text">
            Rolle:{" "}
            <span className="font-medium">
              {ROLE_LABEL[role]}
            </span>
          </p>

          <div className="space-y-3 rounded-md border bg-muted/40 p-4">
            <label
              htmlFor="language-select"
              className="text-sm font-medium text-app-text"
            >
              Ihre Sprache
            </label>
            <Select
              value={myLanguage ?? ""}
              onValueChange={(value) =>
                handleLanguageChange(value as LanguageCode)
              }
              disabled={languageLoading || languageSaving || isRecording}
            >
              <SelectTrigger
                id="language-select"
                className="w-full bg-app-background"
              >
                <SelectValue placeholder="Sprache auswählen …" />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((lang) => (
                  <SelectItem key={lang.code} value={lang.code}>
                    {lang.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {languageLoading && (
              <p className="text-[13px] text-muted-foreground">
                Sprache wird geladen …
              </p>
            )}

            {!myLanguage && !languageLoading && (
              <p className="text-[13px] text-destructive">
                Bitte wählen Sie zuerst Ihre Sprache aus, bevor Sie die
                Live-Übersetzung starten.
              </p>
            )}

            {myLanguage && !otherLanguage && !languageLoading && (
              <p className="text-[13px] text-destructive">
                Warten auf die Sprachwahl der Gegenseite, bevor die
                Live-Übersetzung starten kann.
              </p>
            )}

            {myLanguage && (
              <p className="text-[13px] text-muted-foreground">
                Gegenseite:{" "}
                <span className="font-medium text-app-text">
                  {otherLanguage
                    ? languageLabel(otherLanguage)
                    : "noch nicht gewählt"}
                </span>
              </p>
            )}
          </div>

          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-[13px] font-medium text-muted-foreground">
              Empfangene Audiosegmente: {receivedSegments.length}
            </p>
            {receivedSegments.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {receivedSegments.map((id) => (
                  <li
                    key={id}
                    className="truncate text-[13px] font-mono text-muted-foreground"
                    title={id}
                  >
                    {id}
                  </li>
                ))}
              </ul>
            )}
            {receivedSegments.length === 0 && (
              <p className="text-[13px] text-muted-foreground">
                Noch keine empfangen.
              </p>
            )}
          </div>
          {isRecording && (
            <div className="flex items-center justify-center gap-2 text-sm text-app-text">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-translation-accent motion-safe:animate-pulse" />
              Übersetzung läuft
            </div>
          )}
          <div className="flex justify-center">
            <Button
              onClick={isRecording ? stop : start}
              variant={isRecording ? "destructive" : "default"}
              disabled={!myLanguage || !otherLanguage}
            >
              {isRecording ? "Live-Übersetzung beenden" : "Live-Übersetzung starten"}
            </Button>
          </div>

          <div className="flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                audioQueueRef.current = [];
                isPlayingRef.current = false;
              }}
            >
              Warteschlange leeren
            </Button>
          </div>

          {error && (
            <p className="text-center text-sm text-destructive">{error}</p>
          )}
          <div className="rounded-md border bg-muted/40 p-4">
            <p className="mb-2 text-sm font-medium text-app-text">Transkript</p>
            <div className="space-y-6">
              {transcripts.map((t, i) => (
                <div key={t.id ?? i} className="space-y-2">
                  <p
                    className={
                      t.isFinal
                        ? "text-xl font-medium text-app-text"
                        : "text-xl font-medium text-muted-foreground"
                    }
                  >
                    {t.text}
                  </p>
                  {t.translating && (
                    <span className="block text-[13px] text-muted-foreground">
                      Übersetzung läuft …
                    </span>
                  )}
                  {t.translationError && (
                    <span className="block text-[13px] text-destructive">
                      {t.translationError}
                    </span>
                  )}
                  {t.translation && (
                    <p className="border-l-4 border-translation-accent pl-3 text-lg text-translation-accent">
                      {t.translation}
                    </p>
                  )}
                  {t.backTranslating && (
                    <span className="block text-[13px] text-muted-foreground">
                      Rückübersetzung läuft …
                    </span>
                  )}
                  {t.backTranslationError && (
                    <span className="block text-[13px] text-destructive">
                      {t.backTranslationError}
                    </span>
                  )}
                  {t.backTranslation && (
                    <p className="border-l-4 border-control-accent pl-3 text-base text-control-accent">
                      Rückübersetzung zur Kontrolle: {t.backTranslation}
                    </p>
                  )}
                  {t.synthesizing && (
                    <span className="block text-[13px] text-muted-foreground">
                      Sprachausgabe wird erstellt …
                    </span>
                  )}
                  {t.synthesisError && (
                    <span className="block text-[13px] text-destructive">
                      {t.synthesisError}
                    </span>
                  )}
                </div>
              ))}
              {transcripts.length === 0 && !isRecording && (
                <p className="text-sm text-muted-foreground">
                  Noch kein Transkript.
                </p>
              )}
            </div>
          </div>

          <Button asChild variant="outline" className="w-full">
            <Link to="/dashboard">Zurück zur Übersicht</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

interface DeepgramAlternative {
  transcript?: string;
}

interface DeepgramChannel {
  alternatives?: DeepgramAlternative[];
}

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  channel?: DeepgramChannel;
}

interface BroadcastSpeechPayload {
  clips: string[];
  fromRole: "arzt" | "patient";
  segmentId: string;
  originalText: string;
  translatedText: string;
  sentAt: number;
}

function AkteSection({ title, text }: { title: string; text: string }) {
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold text-app-text">{title}</h2>
      <p className="leading-relaxed text-app-text">{text}</p>
    </div>
  );
}
