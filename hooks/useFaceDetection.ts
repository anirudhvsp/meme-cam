/**
 * useFaceDetection — fixed version
 *
 * Mobile fixes applied:
 * 1. Canvas snapshot is now ALWAYS used (not conditional). On mobile/iOS the
 *    WebGL backend reads stale frames from a live <video> element directly.
 *    Drawing to an offscreen canvas first forces a fresh pixel read every tick.
 * 2. Canvas dimensions now match the video's actual intrinsicWidth/Height so
 *    face-api landmark coordinates aren't scaled wrong on non-16:9 cameras.
 * 3. Detection is skipped when video dimensions are 0 (common on iOS before
 *    first frame fires) — previously this caused face-api to silently return
 *    null and emit score=0 every tick.
 * 4. inputSize bumped to 320 on desktop, kept at 224 on mobile for speed.
 *    scoreThreshold lowered to 0.25 (mobile cameras are often lower quality).
 * 5. Added `video.play()` retry on every detection tick, not just on init.
 *    iOS Safari pauses the video on tab switch and never auto-resumes.
 * 6. Interval is cleared and restarted on every `cameraReady` change so the
 *    interval never double-fires after a rematch.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

declare global {
  interface Window { faceapi: any; }
}

export type Point = { x: number; y: number };
export interface FaceRatios {
  mouthOpenness: number;
  mouthWidth: number;
  leftEyeOpenness: number;
  rightEyeOpenness: number;
  browRaise: number;
}

function dist(a: Point, b: Point) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export function computeRatios(pts: Point[]): FaceRatios {
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

export function ratioSimilarity(a: FaceRatios, b: FaceRatios): number {
  let score = 0;
  for (const { key, weight, sigma } of FEATURE_CONFIG) {
    const diff = a[key] - b[key];
    score += Math.exp(-(diff * diff) / (2 * sigma * sigma)) * weight;
  }
  return Math.round(Math.pow(score, 1.5) * 100);
}

const FACEAPI_SCRIPT = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/dist/face-api.js";
const MODEL_URL      = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model";

function isMobileBrowser() {
  return typeof navigator !== "undefined" &&
    /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

function getDetectionInterval() {
  return isMobileBrowser() ? 900 : 300;
}

function getInputSize() {
  // 224 is fast enough on mobile; 320 gives better landmark accuracy on desktop
  return isMobileBrowser() ? 224 : 320;
}

interface UseFaceDetectionOptions {
  onScore?: (score: number) => void;
  targetRatios: FaceRatios | null;
  active: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

export function useFaceDetection({ onScore, targetRatios, active, videoRef }: UseFaceDetectionOptions) {
  const [modelsReady, setModelsReady]   = useState(false);
  const [cameraReady, setCameraReady]   = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [similarity, setSimilarity]     = useState<number | null>(null);
  const [loadError, setLoadError]       = useState(false);
  const [localStream, setLocalStream]   = useState<MediaStream | null>(null);

  const streamRef    = useRef<MediaStream | null>(null);
  // Offscreen canvas — always used, never null after camera starts
  const canvasRef    = useRef<HTMLCanvasElement | null>(null);
  const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const detectingRef = useRef(false);

  const targetRatiosRef = useRef(targetRatios);
  const activeRef       = useRef(active);
  const onScoreRef      = useRef(onScore);
  useEffect(() => { targetRatiosRef.current = targetRatios; }, [targetRatios]);
  useEffect(() => { activeRef.current = active; },             [active]);
  useEffect(() => { onScoreRef.current = onScore; },           [onScore]);

  // ── Load face-api ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.faceapi?.nets?.tinyFaceDetector?.isLoaded) {
      setModelsReady(true);
      return;
    }

    const script = document.createElement("script");
    script.src   = FACEAPI_SCRIPT;
    script.async = true;
    script.onload = async () => {
      try {
        await window.faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await window.faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);
        setModelsReady(true);
      } catch (e) {
        console.error("face-api model load failed", e);
        setLoadError(true);
      }
    };
    script.onerror = () => setLoadError(true);
    document.head.appendChild(script);
    return () => { if (document.head.contains(script)) document.head.removeChild(script); };
  }, []);

  // ── Camera ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!modelsReady) return;

    const tryGetCamera = async () => {
      const attempts: MediaStreamConstraints[] = [
        { video: { width: { ideal: 480 }, height: { ideal: 360 }, facingMode: "user" }, audio: false },
        { video: { facingMode: "user" }, audio: false },
        { video: true, audio: false },
      ];
      for (const c of attempts) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(c);
          streamRef.current = stream;
          setLocalStream(stream);

          const video = videoRef.current;
          if (video) {
            video.srcObject = stream;
            try { await video.play(); } catch { /* autoplay policy — will retry in detect loop */ }
          }

          // Always create the offscreen canvas upfront.
          // We'll resize it on first detection once we know the video dimensions.
          const cv = document.createElement("canvas");
          cv.width  = 224;
          cv.height = 168;
          canvasRef.current = cv;

          setCameraReady(true);
          return;
        } catch (err) {
          console.warn("getUserMedia failed, retrying:", err);
        }
      }
      setLoadError(true);
    };

    tryGetCamera();
    return () => { streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, [modelsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Detection loop ─────────────────────────────────────────────────────────
  const detect = useCallback(async () => {
    if (detectingRef.current) return;

    const video = videoRef.current;
    if (!video || !window.faceapi) return;

    // Skip if video hasn't decoded its first frame yet.
    // readyState < 2 means no data. videoWidth === 0 means dimensions unknown —
    // this is the common mobile case where face-api returns null and score stays 0.
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;

    // iOS Safari pauses video on tab switch; resume it here every tick.
    if (video.paused || video.ended) {
      try { await video.play(); } catch { /* ignore autoplay block */ }
      return;
    }

    detectingRef.current = true;
    try {
      const canvas = canvasRef.current;
      if (!canvas) { detectingRef.current = false; return; }

      // Resize canvas to match actual video dimensions if they've changed.
      // On mobile the camera resolution can differ from what was requested.
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      // ALWAYS draw to offscreen canvas before running detection.
      // Passing the <video> element directly to face-api on iOS/Android causes
      // the WebGL backend to read a stale (or all-zero) texture — this is the
      // root cause of the "always 0 score on mobile" bug.
      const ctx = canvas.getContext("2d");
      if (!ctx) { detectingRef.current = false; return; }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const inputSize     = getInputSize();
      // Lower score threshold on mobile because front cameras are often lower
      // contrast and overexposed, making detection harder.
      const scoreThreshold = isMobileBrowser() ? 0.25 : 0.35;

      const result = await window.faceapi
        .detectSingleFace(
          canvas,
          new window.faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold }),
        )
        .withFaceLandmarks(true);

      if (!result) {
        setFaceDetected(false);
        setSimilarity(null);
        return;
      }

      setFaceDetected(true);
      if (activeRef.current && targetRatiosRef.current) {
        const score = ratioSimilarity(
          computeRatios(result.landmarks.positions),
          targetRatiosRef.current,
        );
        setSimilarity(score);
        onScoreRef.current?.(score);
      }
    } catch (e) {
      console.warn("Detection error:", e);
    } finally {
      detectingRef.current = false;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cameraReady) return;
    const ms = getDetectionInterval();
    intervalRef.current = setInterval(detect, ms);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [cameraReady, detect]);

  return { modelsReady, cameraReady, faceDetected, similarity, loadError, localStream };
}
