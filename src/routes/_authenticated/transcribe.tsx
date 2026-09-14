import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";

import { getDeepgramToken } from "@/lib/deepgram.functions";
import { translateText } from "@/lib/translate.functions";
import { synthesizeSpeech } from "@/lib/tts.functions";
import { useRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

interface TranscriptItem {
  id: string;
  text: string;
  isFinal: boolean;
  translation?: string;
  translating?: boolean;
  translationError?: string;
  audioClips?: string[];
  synthesizing?: boolean;
  synthesisError?: string;
}

function TranscribePage() {
  const { data: roleData, isLoading: roleLoading } = useRole();
  const role = roleData?.role;
  const fetchTranslate = useServerFn(translateText);
  const fetchSynthesize = useServerFn(synthesizeSpeech);

  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioQueueRef = useRef<string[][]>([]);
  const isPlayingRef = useRef(false);

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

  if (roleLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
        <p className="text-muted-foreground">Rolle wird geladen …</p>
      </main>
    );
  }

  if (role === "spectator" || !role) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Spracherkennung nicht verfügbar</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Die Live-Spracherkennung steht nur Ärzten und Patienten zur
              Verfügung. Ihre aktuelle Rolle:{" "}
              <span className="font-medium text-foreground">
                {role ? ROLE_LABEL[role] : "unbekannt"}
              </span>
              .
            </p>
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
            setTranscripts((prev) => {
              const last = prev[prev.length - 1];
              if (last && !last.isFinal) {
                return [
                  ...prev.slice(0, -1),
                  { id, text: transcript, isFinal: true, translating: true },
                ];
              }
              return [
                ...prev,
                { id, text: transcript, isFinal: true, translating: true },
              ];
            });
            fetchTranslate({ data: { text: transcript } })
              .then((result) => {
                setTranscripts((prev) =>
                  prev.map((item) =>
                    item.id === id
                      ? {
                          ...item,
                          translation: result.translation,
                          translating: false,
                          synthesizing: true,
                        }
                      : item
                  )
                );
                fetchSynthesize({ data: { text: result.translation } })
                  .then((synthResult) => {
                    setTranscripts((prev) =>
                      prev.map((item) =>
                        item.id === id
                          ? {
                              ...item,
                              audioClips: synthResult.clips,
                              synthesizing: false,
                            }
                          : item
                      )
                    );
                    enqueueClips(synthResult.clips);
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
    setIsRecording(false);
  }

  return (
    <main className="flex min-h-screen flex-col items-center bg-background px-4 py-16">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>Live-Spracherkennung</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-sm text-muted-foreground">
            Rolle:{" "}
            <span className="font-medium text-foreground">
              {ROLE_LABEL[role]}
            </span>
          </p>
          <div className="flex justify-center">
            <Button
              onClick={isRecording ? stop : start}
              variant={isRecording ? "destructive" : "default"}
            >
              {isRecording ? "Aufnahme stoppen" : "Aufnahme starten"}
            </Button>
          </div>
          {error && (
            <p className="text-center text-sm text-destructive">{error}</p>
          )}
          <div className="rounded-md border bg-muted/40 p-4">
            <p className="mb-2 text-sm font-medium">Transkript</p>
            <div className="space-y-1">
              {transcripts.map((t, i) => (
                <div key={t.id ?? i} className="space-y-1">
                  <span
                    className={
                      t.isFinal ? "text-foreground" : "text-muted-foreground"
                    }
                  >
                    {t.text + " "}
                  </span>
                  {t.translating && (
                    <span className="block text-xs text-muted-foreground">
                      Übersetzung läuft …
                    </span>
                  )}
                  {t.translationError && (
                    <span className="block text-xs text-destructive">
                      {t.translationError}
                    </span>
                  )}
                  {t.translation && (
                    <span className="block text-sm italic text-muted-foreground">
                      {t.translation}
                    </span>
                  )}
                  {t.synthesizing && (
                    <span className="block text-xs text-muted-foreground">
                      Sprachausgabe wird erstellt …
                    </span>
                  )}
                  {t.synthesisError && (
                    <span className="block text-xs text-destructive">
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
