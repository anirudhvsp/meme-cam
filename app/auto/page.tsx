"use client";

import { useEffect, useRef, useState, useCallback } from "react";

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    faceapi: any;
  }
}

const MEMES = [
  { src: "/meme1.png", label: "1" },
  { src: "/meme2.png", label: "2" },
  { src: "/meme3.png", label: "3" },
  { src: "/meme4.png", label: "4" },
  { src: "/meme5.png", label: "5" },
  { src: "/meme6.png", label: "6" },
  { src: "/meme7.png", label: "7" },
  { src: "/meme8.png", label: "8" },
  { src: "/meme9.png", label: "9" },
  { src: "/meme10.png", label: "10" },
  { src: "/meme11.png", label: "11" },
  { src: "/meme12.png", label: "12" },
  { src: "/meme13.png", label: "13" },
  { src: "/meme14.png", label: "14" },
  { src: "/meme15.png", label: "15" },
];

type Point = { x: number; y: number };

function dist(a: Point, b: Point) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

interface FaceRatios {
  mouthOpenness: number;
  mouthWidth: number;
  leftEyeOpenness: number;
  rightEyeOpenness: number;
  browRaise: number;
}

function computeRatios(pts: Point[]): FaceRatios {
  const faceWidth  = dist(pts[0],  pts[16]);
  const faceHeight = dist(pts[19], pts[8]);
  const mouthH     = dist(pts[51], pts[57]);
  const mouthW     = dist(pts[48], pts[54]);
  const lEyeH      = dist(pts[37], pts[41]);
  const lEyeW      = dist(pts[36], pts[39]);
  const rEyeH      = dist(pts[44], pts[46]);
  const rEyeW      = dist(pts[42], pts[45]);
  const lBrowEye   = dist(pts[19], pts[37]);
  const rBrowEye   = dist(pts[24], pts[44]);
  return {
    mouthOpenness:    mouthH / (mouthW  || 1),
    mouthWidth:       mouthW / (faceWidth || 1),
    leftEyeOpenness:  lEyeH  / (lEyeW   || 1),
    rightEyeOpenness: rEyeH  / (rEyeW   || 1),
    browRaise:        ((lBrowEye + rBrowEye) / 2) / (faceHeight || 1),
  };
}

const FEATURE_CONFIG: { key: keyof FaceRatios; weight: number; sigma: number }[] = [
  { key: "mouthOpenness",    weight: 0.35, sigma: 0.06 },
  { key: "mouthWidth",       weight: 0.20, sigma: 0.04 },
  { key: "leftEyeOpenness",  weight: 0.18, sigma: 0.05 },
  { key: "rightEyeOpenness", weight: 0.18, sigma: 0.05 },
  { key: "browRaise",        weight: 0.09, sigma: 0.04 },
];

function ratioSimilarity(a: FaceRatios, b: FaceRatios): number {
  let score = 0;
  for (const { key, weight, sigma } of FEATURE_CONFIG) {
    const diff = a[key] - b[key];
    const featureSim = Math.exp(-(diff * diff) / (2 * sigma * sigma));
    score += featureSim * weight;
  }
  return Math.round(Math.pow(score, 1.8) * 100);
}

// Preload ratios for all memes — runs once at startup
async function loadAllMemeRatios(): Promise<(FaceRatios | null)[]> {
  return Promise.all(
    MEMES.map(async ({ src }) => {
      try {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = src;
        await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; });
        const result = await window.faceapi
          .detectSingleFace(img, new window.faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }))
          .withFaceLandmarks(true);
        return result ? computeRatios(result.landmarks.positions) : null;
      } catch {
        return null;
      }
    })
  );
}

export default function AutoMatcher() {
  const videoRef      = useRef<HTMLVideoElement>(null);
  const memeImgRef    = useRef<HTMLImageElement>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const intervalRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const allRatiosRef  = useRef<(FaceRatios | null)[]>([]);

  const [status, setStatus]             = useState<"loading" | "ready" | "error">("loading");
  const [loadingStep, setLoadingStep]   = useState("Loading face models...");
  const [faceDetected, setFaceDetected] = useState(false);
  const [bestIndex, setBestIndex]       = useState<number | null>(null);
  const [bestScore, setBestScore]       = useState<number | null>(null);

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
    script.async = true;
    script.onload = async () => {
      try {
        setLoadingStep("Loading landmark model...");
        const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model";
        await window.faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await window.faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);

        setLoadingStep("Analyzing memes...");
        allRatiosRef.current = await loadAllMemeRatios();

        setLoadingStep("Starting camera...");
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360, facingMode: "user" }, audio: false });
        streamRef.current = stream;
        setStatus("ready");
      } catch (e) {
        console.error(e);
        setStatus("error");
      }
    };
    script.onerror = () => setStatus("error");
    document.head.appendChild(script);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      document.head.removeChild(script);
    };
  }, []);

  useEffect(() => {
    if (status === "ready" && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [status]);

  const detectLive = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !window.faceapi) return;

    const result = await window.faceapi
      .detectSingleFace(video, new window.faceapi.TinyFaceDetectorOptions({ inputSize: 224 }))
      .withFaceLandmarks(true);

    if (!result) {
      setFaceDetected(false);
      setBestIndex(null);
      setBestScore(null);
      return;
    }

    setFaceDetected(true);
    const liveRatios = computeRatios(result.landmarks.positions);

    let topScore = -1;
    let topIndex = 0;
    allRatiosRef.current.forEach((memeRatios, i) => {
      if (!memeRatios) return;
      const score = ratioSimilarity(liveRatios, memeRatios);
      if (score > topScore) {
        topScore = score;
        topIndex = i;
      }
    });

    setBestIndex(topIndex);
    setBestScore(topScore);
  }, []);

  useEffect(() => {
    if (status === "ready") {
      intervalRef.current = setInterval(detectLive, 300);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [status, detectLive]);

  const simColor = bestScore == null ? "#555"
    : bestScore > 66 ? "#22c55e"
    : bestScore > 33 ? "#f59e0b"
    : "#ef4444";

  return (
    <main style={{
      minHeight: "100vh", background: "#0f0f0f", color: "#f0f0f0",
      fontFamily: "'Courier New', monospace",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      padding: "24px", gap: "24px",
    }}>
      <h1 style={{ fontSize: "clamp(1.2rem, 2.5vw, 1.8rem)", letterSpacing: "0.15em", textTransform: "uppercase", margin: 0 }}>
        Auto Meme Match
      </h1>

      <a href="/" style={{ fontSize: "0.75rem", color: "#555", textDecoration: "none", letterSpacing: "0.05em" }}>
        Switch to manual mode
      </a>

      {status === "loading" && (
        <div style={{ textAlign: "center", color: "#888", fontSize: "0.9rem" }}>
          <div style={{
            width: 40, height: 40, border: "3px solid #333", borderTop: "3px solid #fff",
            borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 12px",
          }} />
          {loadingStep}
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {status === "error" && (
        <div style={{ color: "#ef4444", textAlign: "center" }}>
          <p>Failed to load models or camera.</p>
          <p style={{ fontSize: "0.8rem", color: "#888" }}>Check console for details.</p>
        </div>
      )}

      {status === "ready" && (
        <div style={{ display: "flex", gap: "32px", alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>

          {/* Webcam */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: "0.75rem", color: "#666", letterSpacing: "0.1em", textTransform: "uppercase" }}>You</span>
            <div style={{
              position: "relative", borderRadius: "12px", overflow: "hidden",
              border: faceDetected ? "2px solid #22c55e" : "2px solid #333",
              width: 480, height: 360, background: "#111", transition: "border-color 0.3s",
            }}>
              <video ref={videoRef} width={480} height={360} autoPlay muted playsInline
                style={{ display: "block", width: "100%", height: "100%" }} />
              {!faceDetected && (
                <div style={{
                  position: "absolute", bottom: 8, left: 8, background: "rgba(0,0,0,0.7)",
                  padding: "4px 10px", borderRadius: 6, fontSize: "0.75rem", color: "#888",
                }}>No face detected</div>
              )}
            </div>
          </div>

          {/* Score */}
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", gap: 8, minWidth: 90,
          }}>
            <div style={{ fontSize: "0.65rem", color: "#555", letterSpacing: "0.08em" }}>MATCH</div>
            <div style={{ fontSize: "2.2rem", fontWeight: "bold", color: simColor, transition: "color 0.4s", minWidth: 70, textAlign: "center" }}>
              {bestScore != null ? `${bestScore}%` : "—"}
            </div>
            <div style={{ fontSize: "0.7rem", color: "#555", textAlign: "center", maxWidth: 80 }}>
              {bestIndex != null ? `Meme ${MEMES[bestIndex].label}` : "—"}
            </div>
          </div>

          {/* Best meme */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: "0.75rem", color: "#666", letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Best Match
            </span>
            <div style={{
              borderRadius: "12px", overflow: "hidden",
              border: `2px solid ${bestIndex != null ? simColor : "#333"}`,
              width: 480, height: 360, background: "#1a1a1a",
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "border-color 0.4s",
            }}>
              {bestIndex != null ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  ref={memeImgRef}
                  src={MEMES[bestIndex].src}
                  alt={`Meme ${MEMES[bestIndex].label}`}
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", transition: "opacity 0.2s" }}
                />
              ) : (
                <div style={{ color: "#444", fontSize: "0.8rem" }}>
                  {faceDetected ? "Searching..." : "Show your face"}
                </div>
              )}
            </div>
          </div>

        </div>
      )}

      {status === "ready" && (
        <p style={{ color: "#333", fontSize: "0.65rem", textAlign: "center", maxWidth: 500 }}>
          Comparing against all {MEMES.length} memes in real-time. No data leaves your device.
        </p>
      )}
    </main>
  );
}
