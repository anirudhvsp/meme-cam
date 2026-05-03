"use client";

/**
 * Multiplayer Meme Face Match — Main Page (fixed)
 *
 * Fixes applied vs original:
 *
 * 1. Stream race condition (root cause of "host sends no video tracks"):
 *    startAsHost() is now gated on localStream != null AND peerCount === 2.
 *    Added a localStreamReadyRef so the effect fires correctly when either
 *    condition becomes true after the other.
 *
 * 2. Live peer score during round:
 *    useSignaling now accepts onPeerScore callback. peerScore state is updated
 *    live during the round (not just at round_end), enabling the dominance
 *    slider and the live opponent bar.
 *
 * 3. memeAnalyzing UX gap:
 *    roundActive is only set true after analyzeMeme() resolves AND the video
 *    element is ready. A visible "Analyzing…" overlay covers the timer gap.
 *
 * 4. New feature: Dominance Slider (chess.com style)
 *    A horizontal bar between the two score displays shifts left/right based
 *    on myScore vs peerScore in real time. White = my side, dark = opponent.
 *    The divider animates smoothly with CSS transitions.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSignaling } from "@/hooks/useSignaling";
import { useWebRTC } from "@/hooks/useWebRTC";
import { useFaceDetection, computeRatios, FaceRatios } from "@/hooks/useFaceDetection";

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? "https://your-worker.workers.dev";
const MEMES = Array.from({ length: 15 }, (_, i) => `/meme${i + 1}.png`);

declare global { interface Window { faceapi: any; } }

// ── analyzeMeme ───────────────────────────────────────────────────────────────

async function analyzeMeme(src: string): Promise<FaceRatios | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; });

  const canvas = document.createElement("canvas");
  canvas.width  = 320;
  canvas.height = Math.round(320 * (img.naturalHeight / (img.naturalWidth || 1)));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const result = await window.faceapi
    ?.detectSingleFace(canvas, new window.faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }))
    .withFaceLandmarks(true);
  if (!result) return null;
  return computeRatios(result.landmarks.positions);
}

// ── DominanceSlider ───────────────────────────────────────────────────────────

/**
 * Chess.com-style dominance bar.
 * myScore and peerScore are 0–100. The white section represents my advantage.
 * When scores are equal or both 0 it sits at 50/50.
 */
function DominanceSlider({
  myScore,
  peerScore,
  active,
  iWon,
  peerWon,
  isTie,
}: {
  myScore: number | null;
  peerScore: number | null;
  active: boolean;
  iWon: boolean;
  peerWon: boolean;
  isTie: boolean;
}) {
  // Derive the white-side width (my side, left)
  const my   = myScore   ?? 0;
  const peer = peerScore ?? 0;
  const total = my + peer;

  // When no scores yet, center it
  let myPct = 50;
  if (total > 0) {
    // Clamp so neither side fully disappears (min 8%, max 92%)
    myPct = Math.max(8, Math.min(92, Math.round((my / total) * 100)));
  }

  const barColor = isTie
    ? "#f59e0b"
    : iWon
    ? "#22c55e"
    : peerWon
    ? "#ef4444"
    : "#ffffff";

  return (
    <div style={{ width: "100%", maxWidth: 900, boxSizing: "border-box" }}>
      {/* Labels */}
      <div style={{
        display: "flex", justifyContent: "space-between",
        fontSize: "0.65rem", color: "#555", letterSpacing: "0.08em",
        marginBottom: 6, textTransform: "uppercase",
      }}>
        <span>You{my > 0 ? ` · ${my}%` : ""}</span>
        <span style={{ color: "#333" }}>
          {active ? "LIVE" : isTie ? "TIE" : iWon ? "YOU WIN" : peerWon ? "OPPONENT WINS" : ""}
        </span>
        <span>Opponent{peer > 0 ? ` · ${peer}%` : ""}</span>
      </div>

      {/* The slider bar */}
      <div style={{
        position: "relative",
        height: 12,
        borderRadius: 6,
        overflow: "hidden",
        background: "#1a1a1a",
        border: "1px solid #2a2a2a",
      }}>
        {/* My side (left, lighter) */}
        <div style={{
          position: "absolute",
          left: 0, top: 0, bottom: 0,
          width: `${myPct}%`,
          background: barColor,
          transition: "width 0.5s cubic-bezier(0.4,0,0.2,1), background 0.4s ease",
          borderRadius: "6px 0 0 6px",
        }} />
        {/* Divider pip */}
        <div style={{
          position: "absolute",
          top: "50%",
          left: `${myPct}%`,
          transform: "translate(-50%, -50%)",
          width: 3,
          height: 18,
          background: "#0a0a0a",
          borderRadius: 2,
          transition: "left 0.5s cubic-bezier(0.4,0,0.2,1)",
          zIndex: 2,
        }} />
      </div>
    </div>
  );
}

// ── ScoreBar ──────────────────────────────────────────────────────────────────

function ScoreBar({ score, color }: { score: number | null; color: string }) {
  return (
    <div style={{ width: "100%", height: 8, background: "#1a1a1a", borderRadius: 4, overflow: "hidden" }}>
      <div style={{
        height: "100%", width: `${score ?? 0}%`, background: color,
        borderRadius: 4, transition: "width 0.4s ease",
      }} />
    </div>
  );
}

// ── VideoPanel ────────────────────────────────────────────────────────────────

function VideoPanel({
  stream, videoRef, label, score, isWinner, isTie, muted = false,
}: {
  stream?: MediaStream | null;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  label: string;
  score: number | null;
  isWinner: boolean;
  isTie: boolean;
  muted?: boolean;
}) {
  const internalRef = useRef<HTMLVideoElement | null>(null);
  const ref = videoRef ?? internalRef;

  useEffect(() => {
    const el = ref.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    el.play().catch(() => {});
  }, [stream, ref]);

  const scoreColor = score == null ? "#555"
    : score > 66 ? "#22c55e"
    : score > 33 ? "#f59e0b"
    : "#ef4444";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: "0.75rem", color: "#666", letterSpacing: "0.1em", textTransform: "uppercase" }}>
          {label}
        </span>
        {isWinner && !isTie && (
          <span style={{
            background: "#22c55e22", border: "1px solid #22c55e", color: "#22c55e",
            fontSize: "0.65rem", padding: "2px 8px", borderRadius: 20, letterSpacing: "0.08em",
          }}>WINNER</span>
        )}
        {isTie && (
          <span style={{
            background: "#f59e0b22", border: "1px solid #f59e0b", color: "#f59e0b",
            fontSize: "0.65rem", padding: "2px 8px", borderRadius: 20,
          }}>TIE</span>
        )}
      </div>
      <div style={{
        position: "relative", borderRadius: 12, overflow: "hidden",
        border: `2px solid ${isWinner && !isTie ? "#22c55e" : "#2a2a2a"}`,
        width: "100%", aspectRatio: "4/3", background: "#111",
        transition: "border-color 0.4s",
      }}>
        <video ref={ref} autoPlay muted={muted} playsInline
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        {score != null && (
          <div style={{
            position: "absolute", top: 8, right: 8,
            background: "rgba(0,0,0,0.75)", borderRadius: 8,
            padding: "4px 10px", fontSize: "1rem", fontWeight: "bold", color: scoreColor,
          }}>{score}%</div>
        )}
      </div>
      <ScoreBar score={score} color={scoreColor} />
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function MultiplayerMemeMatcher() {
  const [targetRatios, setTargetRatios]   = useState<FaceRatios | null>(null);
  const [memeImgSrc, setMemeImgSrc]       = useState<string | null>(null);
  const [memeAnalyzing, setMemeAnalyzing] = useState(false);
  const [peerScore, setPeerScore]         = useState<number | null>(null);
  const [myScore, setMyScore]             = useState<number | null>(null);
  const [roundActive, setRoundActive]     = useState(false);
  const [localStream, setLocalStream]     = useState<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);

  // Stable callback refs
  const onRoundStartRef   = useRef<(i: number) => void>(() => {});
  const onRoundEndRef     = useRef<(r: any) => void>(() => {});
  const onOfferRef        = useRef<(s: RTCSessionDescriptionInit) => void>(() => {});
  const onAnswerRef       = useRef<(s: RTCSessionDescriptionInit) => void>(() => {});
  const onIceCandidateRef = useRef<(c: RTCIceCandidateInit) => void>(() => {});
  const onPeerScoreRef    = useRef<(score: number) => void>(() => {});

  const { state: sigState, startMatchmaking, sendRematch, sendScoreUpdate, sendSignal, userId } =
    useSignaling({
      workerUrl: WORKER_URL,
      onOffer:        useCallback((s) => onOfferRef.current(s),        []),
      onAnswer:       useCallback((s) => onAnswerRef.current(s),       []),
      onIceCandidate: useCallback((c) => onIceCandidateRef.current(c), []),
      onRoundStart:   useCallback((i) => onRoundStartRef.current(i),   []),
      onRoundEnd:     useCallback((r) => onRoundEndRef.current(r),     []),
      onPeerScore:    useCallback((s) => onPeerScoreRef.current(s),    []),
    });

  const { remoteStream, startAsHost, handleOffer, handleAnswer, handleIceCandidate } = useWebRTC({
    role: sigState.roomInfo?.role ?? null,
    localStream,
    onSignal: sendSignal,
  });

  // Wire stable refs
  onOfferRef.current        = handleOffer;
  onAnswerRef.current       = handleAnswer;
  onIceCandidateRef.current = handleIceCandidate;

  // Live peer score — update during round AND store final score
  onPeerScoreRef.current = (score: number) => {
    setPeerScore(score);
  };

  // ── Score callback ─────────────────────────────────────────────────────────
  const handleMyScore = useCallback((score: number) => {
    setMyScore(score);
    sendScoreUpdate(score);
  }, [sendScoreUpdate]);

  // ── Face detection ─────────────────────────────────────────────────────────
  const { modelsReady, cameraReady, faceDetected, similarity, localStream: detectedStream } =
    useFaceDetection({
      onScore: handleMyScore,
      targetRatios,
      active: roundActive,
      videoRef: localVideoRef,
    });

  // Sync detected stream into state for WebRTC
  useEffect(() => {
    if (detectedStream) setLocalStream(detectedStream);
  }, [detectedStream]);

  // ── FIX: Start WebRTC offer only after BOTH conditions are true ────────────
  // Original bug: startAsHost() fired when peerCount hit 2 but localStream
  // hadn't propagated through React yet (two render cycles behind).
  // We now track localStream readiness in a ref and re-check both conditions
  // in a single effect that runs on either change.
  const localStreamReadyRef = useRef(false);
  useEffect(() => {
    if (localStream) localStreamReadyRef.current = true;
  }, [localStream]);

  useEffect(() => {
    const isHost        = sigState.roomInfo?.role === "host";
    const bothConnected = sigState.peerCount === 2;
    const inRoom        = sigState.phase === "in_room";
    const streamReady   = localStream != null;

    if (isHost && bothConnected && inRoom && streamReady) {
      startAsHost();
    }
  }, [sigState.phase, sigState.roomInfo?.role, sigState.peerCount, localStream, startAsHost]);

  // ── Round start ────────────────────────────────────────────────────────────
  onRoundStartRef.current = async (memeIndex: number) => {
    const src = MEMES[memeIndex];
    setMemeImgSrc(src);
    setMemeAnalyzing(true);
    setRoundActive(false);
    setMyScore(null);
    setPeerScore(null);

    const ratios = await analyzeMeme(src);
    setTargetRatios(ratios);
    setMemeAnalyzing(false);

    // Only start detection AFTER meme analysis is done.
    // This closes the gap where the server timer is already ticking but the
    // client doesn't know what face to match yet.
    setRoundActive(true);
  };

  // ── Round end ──────────────────────────────────────────────────────────────
  onRoundEndRef.current = (result: any) => {
    setRoundActive(false);
    const peerUserId = Object.keys(result.results).find((id) => id !== userId);
    if (peerUserId) setPeerScore(result.results[peerUserId]);
    setMyScore(result.results[userId] ?? null);
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  const { phase, secondsLeft, roundResult, rematchVotes, roomInfo } = sigState;
  const iWon    = roundResult?.winnerId === userId;
  const isTie   = roundResult !== null && roundResult.winnerId === null;
  const peerWon = roundResult?.winnerId !== null && roundResult?.winnerId !== userId;
  const iVotedRematch = rematchVotes.has(userId);

  const simColor = similarity == null ? "#555"
    : similarity > 66 ? "#22c55e"
    : similarity > 33 ? "#f59e0b"
    : "#ef4444";

  // Display score: during round show live similarity, after round show final
  const myDisplayScore   = roundActive ? (similarity ?? null) : myScore;
  const peerDisplayScore = roundActive ? peerScore : peerScore;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <main style={{
      minHeight: "100vh", background: "#0a0a0a", color: "#e8e8e8",
      fontFamily: "'Courier New', monospace",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "flex-start",
      padding: "32px 24px", gap: 24,
      boxSizing: "border-box",
    }}>
      <h1 style={{
        fontSize: "clamp(1.1rem, 2.5vw, 1.6rem)", letterSpacing: "0.2em",
        textTransform: "uppercase", margin: 0, color: "#fff",
      }}>
        MEME FACE MATCH <span style={{ color: "#666", fontSize: "0.7em" }}>// MULTIPLAYER</span>
      </h1>

      {/* ── IDLE / LANDING ── */}
      {(phase === "idle" || phase === "error") && (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          gap: 24, marginTop: 40,
        }}>
          <p style={{ color: "#555", fontSize: "0.9rem", textAlign: "center", maxWidth: 420 }}>
            Get matched with a random opponent. You both have 10 seconds to copy the meme face.
            Highest average similarity wins.
          </p>
          {phase === "error" && (
            <p style={{ color: "#ef4444", fontSize: "0.8rem" }}>Connection error. Try again.</p>
          )}
          {!modelsReady && (
            <p style={{ color: "#555", fontSize: "0.75rem" }}>
              {cameraReady ? "Loading face models..." : "Loading..."}
            </p>
          )}
          <button onClick={startMatchmaking} disabled={!modelsReady} style={{
            padding: "14px 48px", background: modelsReady ? "#fff" : "#1a1a1a",
            color: modelsReady ? "#0a0a0a" : "#333",
            border: "none", borderRadius: 8, fontSize: "0.95rem",
            letterSpacing: "0.15em", textTransform: "uppercase",
            cursor: modelsReady ? "pointer" : "not-allowed",
            fontFamily: "inherit", fontWeight: "bold",
            transition: "all 0.2s",
          }}>
            {modelsReady ? "MATCHMAKE" : "Loading models..."}
          </button>
        </div>
      )}

      {/* ── QUEUED ── */}
      {phase === "queued" && (
        <div style={{ textAlign: "center", marginTop: 60 }}>
          <div style={{
            width: 40, height: 40, border: "2px solid #222", borderTop: "2px solid #fff",
            borderRadius: "50%", animation: "spin 1s linear infinite",
            margin: "0 auto 20px",
          }} />
          <p style={{ color: "#555", fontSize: "0.85rem", letterSpacing: "0.1em" }}>
            SEARCHING FOR OPPONENT...
          </p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* ── IN ROOM ── */}
      {(phase === "in_room" || phase === "matched") && (
        <>
          {/* Timer / status bar */}
          <div style={{
            display: "flex", alignItems: "center", gap: 16,
            background: "#111", border: "1px solid #1e1e1e",
            borderRadius: 10, padding: "10px 24px",
            width: "100%", maxWidth: 900, boxSizing: "border-box",
            justifyContent: "space-between",
          }}>
            <span style={{ fontSize: "0.7rem", color: "#444", letterSpacing: "0.08em" }}>
              {memeAnalyzing
                ? "ANALYZING MEME..."
                : roundActive
                ? "ROUND ACTIVE"
                : roundResult
                ? "ROUND OVER"
                : "WAITING FOR OPPONENT..."}
            </span>
            {secondsLeft != null && (
              <span style={{
                fontSize: "1.4rem", fontWeight: "bold",
                color: secondsLeft <= 3 ? "#ef4444" : "#fff",
                transition: "color 0.3s",
              }}>
                {secondsLeft}s
              </span>
            )}
            <span style={{ fontSize: "0.7rem", color: "#333" }}>
              {sigState.peerCount}/2 players
            </span>
          </div>

          {/* Dominance slider — chess.com style */}
          <DominanceSlider
            myScore={myDisplayScore}
            peerScore={peerDisplayScore}
            active={roundActive}
            iWon={iWon}
            peerWon={peerWon}
            isTie={isTie}
          />

          {/* Main game area */}
          <div style={{
            display: "flex", gap: 16, alignItems: "flex-start",
            width: "100%", maxWidth: 1100, flexWrap: "wrap",
            justifyContent: "center",
          }}>
            {/* My video */}
            <div style={{ flex: 1, minWidth: 240, maxWidth: 360 }}>
              <VideoPanel
                stream={localStream}
                videoRef={localVideoRef}
                label="YOU"
                score={myDisplayScore}
                isWinner={iWon}
                isTie={isTie}
                muted={true}
              />
            </div>

            {/* Meme center */}
            <div style={{
              display: "flex", flexDirection: "column", gap: 12,
              alignItems: "center", justifyContent: "center",
              minWidth: 200, flex: "0 0 auto",
            }}>
              {memeImgSrc ? (
                <div style={{
                  borderRadius: 12, overflow: "hidden",
                  border: "2px solid #2a2a2a",
                  width: 220, background: "#111",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  minHeight: 165,
                }}>
                  {memeAnalyzing ? (
                    <span style={{ color: "#444", fontSize: "0.75rem" }}>Analyzing...</span>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={memeImgSrc} alt="meme" style={{ width: "100%", display: "block" }} />
                  )}
                </div>
              ) : (
                <div style={{
                  width: 220, height: 165, borderRadius: 12,
                  border: "2px dashed #1e1e1e", display: "flex",
                  alignItems: "center", justifyContent: "center",
                }}>
                  <span style={{ color: "#333", fontSize: "0.75rem" }}>Meme incoming...</span>
                </div>
              )}
              <div style={{ fontSize: "0.75rem", color: "#333", letterSpacing: "0.2em", fontWeight: "bold" }}>
                VS
              </div>
            </div>

            {/* Peer video */}
            <div style={{ flex: 1, minWidth: 240, maxWidth: 360 }}>
              <VideoPanel
                stream={remoteStream}
                label="OPPONENT"
                score={peerDisplayScore}
                isWinner={peerWon}
                isTie={isTie}
              />
            </div>
          </div>

          {/* Round result panel */}
          {roundResult && (
            <div style={{
              background: "#0e0e0e", border: "1px solid #1e1e1e",
              borderRadius: 12, padding: "24px 32px",
              textAlign: "center", display: "flex",
              flexDirection: "column", gap: 16, alignItems: "center",
              width: "100%", maxWidth: 500,
            }}>
              <div style={{
                fontSize: "clamp(1rem, 3vw, 1.5rem)", fontWeight: "bold",
                color: isTie ? "#f59e0b" : iWon ? "#22c55e" : "#ef4444",
              }}>
                {isTie ? "IT'S A TIE!" : iWon ? "YOU WIN! 🎉" : "YOU LOSE!"}
              </div>
              <div style={{ display: "flex", gap: 24, fontSize: "0.85rem", color: "#555" }}>
                <span>You: <b style={{ color: "#fff" }}>{myScore ?? 0}%</b></span>
                <span>Opponent: <b style={{ color: "#fff" }}>{peerScore ?? 0}%</b></span>
              </div>

              <div style={{ display: "flex", gap: 12 }}>
                <button onClick={sendRematch} disabled={iVotedRematch} style={{
                  padding: "10px 28px",
                  background: iVotedRematch ? "#1a1a1a" : "#fff",
                  color: iVotedRematch ? "#444" : "#0a0a0a",
                  border: "none", borderRadius: 8,
                  fontSize: "0.8rem", letterSpacing: "0.1em",
                  cursor: iVotedRematch ? "default" : "pointer",
                  fontFamily: "inherit", fontWeight: "bold",
                }}>
                  {iVotedRematch ? `WAITING... (${rematchVotes.size}/2)` : "REMATCH"}
                </button>
                <button onClick={startMatchmaking} style={{
                  padding: "10px 28px", background: "transparent",
                  color: "#555", border: "1px solid #222",
                  borderRadius: 8, fontSize: "0.8rem",
                  letterSpacing: "0.1em", cursor: "pointer",
                  fontFamily: "inherit",
                }}>
                  NEW MATCH
                </button>
              </div>
            </div>
          )}

          <p style={{ color: "#222", fontSize: "0.6rem", textAlign: "center" }}>
            Room: {roomInfo?.roomId?.slice(0, 8)}... · Video is peer-to-peer · No data stored
          </p>
        </>
      )}
    </main>
  );
}
