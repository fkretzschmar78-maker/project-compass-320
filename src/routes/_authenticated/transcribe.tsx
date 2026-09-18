import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";

import { getDeepgramToken } from "@/lib/deepgram.functions";
import { translateText } from "@/lib/translate.functions";
import { synthesizeSpeech } from "@/lib/tts.functions";
import { logConversationSegment } from "@/lib/conversation-log.functions";
import { setMyLanguage, getSessionLanguages } from "@/lib/session-language.functions";
import { getLiveKitToken } from "@/lib/livekit.functions";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import type { LanguageCode } from "@/lib/languages";
import { useRole } from "@/hooks/use-role";
import { Room, RoomEvent, Track } from "livekit-client";
import type {
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
} from "livekit-client";

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
import { cn } from "@/lib/utils";
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
  const fetchLiveKitToken = useServerFn(getLiveKitToken);

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
  const [useStreamingTts, setUseStreamingTts] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [liveKitConnected, setLiveKitConnected] = useState(false);
  const [liveKitParticipantCount, setLiveKitParticipantCount] = useState(0);
  const [liveKitError, setLiveKitError] = useState<string | null>(null);
  const [liveKitPublishedCount, setLiveKitPublishedCount] = useState(0);
  const [liveKitReceivedCount, setLiveKitReceivedCount] = useState(0);
  const [liveKitLastSender, setLiveKitLastSender] = useState<string | null>(
    null,
  );
  const [publishCaptureMuted, setPublishCaptureMuted] = useState<boolean | null>(
    null,
  );


  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioQueueRef = useRef<string[][]>([]);
  const isPlayingRef = useRef(false);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const languagesReadyRef = useRef(false);
  const keepAliveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamUrlRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const roomRef = useRef<Room | null>(null);
  // Sender: aktuell über LiveKit veröffentlichte Audiospur aus dem <audio>-Element
  const publishedTrackRef = useRef<MediaStreamTrack | null>(null);
  // Empfänger: <audio>-Element für eingehende LiveKit-Spuren der Gegenseite
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);


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

  async function streamTts(text: string) {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Keine Sitzung");

      // Alte LiveKit-Spur aufräumen, bevor ein neuer Stream startet
      if (publishedTrackRef.current && roomRef.current) {
        try {
          roomRef.current.localParticipant.unpublishTrack(
            publishedTrackRef.current,
          );
          publishedTrackRef.current.stop();
        } catch {
          // ignore
        }
        publishedTrackRef.current = null;
      }

      const mimeType = "audio/mpeg";
      if (!MediaSource.isTypeSupported(mimeType)) {
        throw new Error(`MediaSource unterstützt ${mimeType} in diesem Browser nicht`);
      }

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeAttribute("src");
        audioRef.current.load();
      }

      if (streamUrlRef.current) {
        URL.revokeObjectURL(streamUrlRef.current);
        streamUrlRef.current = null;
        setStreamUrl(null);
      }

      const mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(mediaSource);
      streamUrlRef.current = objectUrl;
      setStreamUrl(objectUrl);


      mediaSource.addEventListener("sourceopen", async () => {
        try {
          const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
          const queue: Uint8Array[] = [];
          let started = false;
          let sourceBufferBusy = false;
          let streamDone = false;

          const flushQueue = () => {
            if (sourceBufferBusy || queue.length === 0) return;
            const chunk = queue.shift()!;
            try {
              sourceBufferBusy = true;
              sourceBuffer.appendBuffer(new Uint8Array(chunk));
            } catch (err) {
              console.error("appendBuffer-Fehler", err);
              sourceBufferBusy = false;
              flushQueue();
            }
          };

          sourceBuffer.addEventListener("updateend", () => {
            sourceBufferBusy = false;
            if (!started) {
              started = true;

              // Erst nachdem der erste Chunk wirklich im SourceBuffer liegt:
              // Eigene Übersetzung lokal abspielen ODER — falls eine LiveKit-
              // Verbindung besteht — stumm an das <audio>-Element abgeben und
              // per captureStream() an den Raum senden.
              const room = roomRef.current;
              const audioEl = audioRef.current;

              if (room && audioEl) {
                audioEl.muted = true;

                // Diagnose: muted-State im Moment des captureStream()-Aufrufs
                setPublishCaptureMuted(audioEl.muted);

                const capture = (
                  audioEl as HTMLAudioElement & {
                    captureStream?: () => MediaStream;
                  }
                ).captureStream;


                if (!capture) {
                  setLiveKitError(
                    "Dieser Browser unterstützt captureStream() nicht — keine LiveKit-Übertragung.",
                  );
                } else if (!room.localParticipant.permissions?.canPublish) {
                  // Spectator: zuhören, aber nichts veröffentlichen
                } else {
                  try {
                    const mediaStream = capture.call(audioEl);
                    const mediaTrack = mediaStream.getAudioTracks()[0];
                    if (mediaTrack) {
                      // Sofort referenzieren, damit stop()/disconnect sie aufräumen kann,
                      // auch wenn publishTrack noch nicht resolved ist.
                      publishedTrackRef.current = mediaTrack;
                      room.localParticipant
                        .publishTrack(mediaTrack, {
                          source: Track.Source.Unknown,
                        })
                        .then(() => {
                          setLiveKitPublishedCount((n) => n + 1);
                        })
                        .catch((err) => {
                          console.error("LiveKit-Publish fehlgeschlagen:", err);
                          setLiveKitError(
                            err instanceof Error
                              ? err.message
                              : "LiveKit-Publish fehlgeschlagen",
                          );
                        });

                    }
                  } catch (err) {
                    console.error("LiveKit-Publish fehlgeschlagen:", err);
                    setLiveKitError(
                      err instanceof Error
                        ? err.message
                        : "LiveKit-Publish fehlgeschlagen",
                    );
                  }
                }
              } else if (audioEl) {
                // Keine LiveKit-Verbindung: eigene Übersetzung normal lokal hören
                audioEl.muted = false;
              }

              audioRef.current?.play().catch((err) =>
                console.error("Audio-Wiedergabe konnte nicht starten:", err),
              );
            }
            flushQueue();

            if (
              streamDone &&
              queue.length === 0 &&
              !sourceBufferBusy &&
              mediaSource.readyState === "open"
            ) {
              try {
                mediaSource.endOfStream();
              } catch {
                // ignore
              }
            }
          });

          sourceBuffer.addEventListener("error", (err) => {
            console.error("SourceBuffer-Fehler", err);
          });

          const res = await fetch("/api/synthesize-stream", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ text }),
          });
          if (!res.ok) throw new Error(`Stream-TTS fehlgeschlagen: ${res.status}`);
          if (!res.body) throw new Error("Kein Response-Body");

          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              streamDone = true;
              if (
                queue.length === 0 &&
                !sourceBufferBusy &&
                mediaSource.readyState === "open"
              ) {
                try {
                  mediaSource.endOfStream();
                } catch {
                  // ignore
                }
              }
              break;
            }
            queue.push(value);
            flushQueue();
          }
        } catch (err) {
          console.error("MediaSource-Fehler:", err);
          if (mediaSource.readyState === "open") {
            try {
              mediaSource.endOfStream();
            } catch {
              // ignore
            }
          }
        }
      });

      mediaSource.addEventListener("error", (err) => {
        console.error("MediaSource-Fehler", err);
      });
    } catch (err) {
      console.error("Stream-TTS-Fehler:", err);
    }
  }

  async function connectLiveKit() {
    try {
      setLiveKitError(null);
      const result = await fetchLiveKitToken();
      if (!result.token || !result.url) {
        throw new Error("Kein LiveKit-Token erhalten");
      }

      const room = new Room();
      roomRef.current = room;

      room.on(RoomEvent.Connected, () => {
        setLiveKitConnected(true);
        setLiveKitParticipantCount(room.numParticipants);
        setLiveKitError(null);
      });

      room.on(RoomEvent.Disconnected, () => {
        setLiveKitConnected(false);
        setLiveKitParticipantCount(0);
      });

      room.on(RoomEvent.ParticipantConnected, () => {
        setLiveKitParticipantCount(room.numParticipants);
      });

      room.on(RoomEvent.ParticipantDisconnected, () => {
        setLiveKitParticipantCount(room.numParticipants);
      });

      // Empfänger-Seite: eingehende Audio-Spur der Gegenseite automatisch
      // an ein <audio>-Element hängen und abspielen.
      room.on(
        RoomEvent.TrackSubscribed,
        (
          track: RemoteTrack,
          _publication: RemoteTrackPublication,
          participant: RemoteParticipant,
        ) => {
          if (track.kind !== Track.Kind.Audio) return;
          const el = remoteAudioRef.current;
          if (!el) return;
          track.attach(el);
          el.play().catch((err) =>
            console.error("Remote-Audio konnte nicht starten:", err),
          );
          setLiveKitReceivedCount((n) => n + 1);
          setLiveKitLastSender(participant.identity);
        },
      );


      await room.connect(result.url, result.token);
    } catch (err) {
      setLiveKitConnected(false);
      setLiveKitError(
        err instanceof Error ? err.message : "LiveKit-Verbindung fehlgeschlagen",
      );
    }
  }

  function disconnectLiveKit() {
    if (publishedTrackRef.current) {
      try {
        publishedTrackRef.current.stop();
      } catch {
        // ignore
      }
      publishedTrackRef.current = null;
    }
    if (roomRef.current) {
      roomRef.current.disconnect();
      roomRef.current = null;
    }
    setLiveKitConnected(false);
    setLiveKitParticipantCount(0);
  }

  useEffect(() => {
    return () => {
      void stop();
      void disconnectLiveKit();
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
            if (typeof payload.sentAt === "number") {
              setLastBroadcastLatency((Date.now() - payload.sentAt) / 1000);
            }
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
      wsUrl.searchParams.set("endpointing", "10");
      wsUrl.searchParams.set("interim_results", "true");
      wsUrl.searchParams.append("keyterm", "Metformin");
      wsUrl.searchParams.append("keyterm", "Hypertonie");
      wsUrl.searchParams.append("keyterm", "Bauchschmerzen");
      wsUrl.searchParams.append("keyterm", "Appendizitis");
      wsUrl.searchParams.append("keyterm", "Appendix");
      wsUrl.searchParams.append("keyterm", "Ultraschall");


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
        keepAliveIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "KeepAlive" }));
          }
        }, 5000);
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
                    if (useStreamingTts) {
                      const ttsReceivedAt = Date.now();
                      setTranscripts((prev) =>
                        prev.map((item) =>
                          item.id === id
                            ? {
                                ...item,
                                synthesizing: false,
                                ttsReceivedAt,
                              }
                            : item
                        )
                      );
                      void streamTts(result.translation);
                    } else {
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
                            void channel.send({
                              type: "broadcast",
                              event: "speech",
                              payload: {
                                clips: synthResult.clips,
                                fromRole: role,
                                segmentId: id,
                                originalText: transcript,
                                translatedText: result.translation,
                                sentAt: Date.now(),
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
                    }
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
        if (keepAliveIntervalRef.current) {
          clearInterval(keepAliveIntervalRef.current);
          keepAliveIntervalRef.current = null;
        }
        console.error("WebSocket-Fehler", event);
      };


      ws.onclose = (event) => {
        if (keepAliveIntervalRef.current) {
          clearInterval(keepAliveIntervalRef.current);
          keepAliveIntervalRef.current = null;
        }
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
    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
      keepAliveIntervalRef.current = null;
    }

    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.removeAttribute("src");
        audioRef.current.load();
      } catch {
        // ignore
      }
    }

    if (streamUrlRef.current) {
      URL.revokeObjectURL(streamUrlRef.current);
      streamUrlRef.current = null;
      setStreamUrl(null);
    }

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
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-[13px] font-medium text-app-text">
                  Streaming-TTS testen (nur lokal)
                </p>
                <p className="text-[13px] text-muted-foreground">
                  Spielt die Übersetzung progressiv direkt im Browser ab.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={useStreamingTts}
                onClick={() => setUseStreamingTts((prev) => !prev)}
                className={cn(
                  "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-control-accent",
                  useStreamingTts ? "bg-translation-accent" : "bg-muted",
                )}
              >
                <span
                  className={cn(
                    "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                    useStreamingTts ? "translate-x-6" : "translate-x-1",
                  )}
                />
              </button>
            </div>
          </div>

          <audio
            ref={audioRef}
            controls
            src={streamUrl ?? undefined}
            className="w-full"
          />


          {/* Empfänger: hier landen eingehende LiveKit-Audiospuren der Gegenseite */}
          <audio ref={remoteAudioRef} className="hidden" />

          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-[13px] font-medium text-muted-foreground">
              Empfangene Audiosegmente: {receivedSegments.length}
            </p>
            {lastBroadcastLatency !== null && (
              <p className="text-[13px] text-muted-foreground">
                Letzte Antwort kam nach{" "}
                {lastBroadcastLatency.toFixed(1).replace(".", ",")}s an
              </p>
            )}
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

          <div className="rounded-md border bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-[13px] font-medium text-app-text">
                  LiveKit-Raum (Test)
                </p>
                <p className="truncate text-[13px] text-muted-foreground">
                  Status:{" "}
                  <span
                    className={
                      liveKitConnected
                        ? "font-medium text-translation-accent"
                        : undefined
                    }
                  >
                    {liveKitConnected ? "verbunden" : "getrennt"}
                  </span>
                  {" · "}Teilnehmer: {liveKitParticipantCount}
                </p>
                <p className="truncate text-[13px] text-muted-foreground">
                  Spuren veröffentlicht: {liveKitPublishedCount}
                  {" · "}Spuren empfangen: {liveKitReceivedCount}
                  {liveKitLastSender && (
                    <span className="ml-1">
                      · Letzter Sender: {liveKitLastSender}
                    </span>
                  )}
                </p>
                {publishCaptureMuted !== null && (
                  <p className="text-[13px] text-muted-foreground">
                    Element stumm beim Capture:{" "}
                    {publishCaptureMuted ? "ja" : "nein"}
                  </p>
                )}

                {liveKitError && (
                  <p className="text-[13px] text-destructive">{liveKitError}</p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={liveKitConnected ? disconnectLiveKit : connectLiveKit}
              >
                {liveKitConnected ? "Trennen" : "Verbinden"}
              </Button>
            </div>
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
                  {t.finalAt && (
                    <p className="text-[13px] text-muted-foreground">
                      {[
                        t.translationReceivedAt &&
                          `Übersetzung: ${(
                            (t.translationReceivedAt - t.finalAt) /
                            1000
                          ).toFixed(1).replace(".", ",")}s`,
                        t.ttsReceivedAt &&
                          t.translationReceivedAt &&
                          `Sprachausgabe: ${(
                            (t.ttsReceivedAt - t.translationReceivedAt) /
                            1000
                          ).toFixed(1).replace(".", ",")}s`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
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
