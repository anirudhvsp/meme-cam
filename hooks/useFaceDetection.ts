/**
 * useFaceDetection
 * Loads face-api.js models, starts the camera, and runs detection on an interval.
 * Exposes similarity score computed against a target FaceRatios object.
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

function getDetectionInterval() {
  const isMobile = typeof navigator !== "undefined" &&
    /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  return isMobile ? 800 : 300;
}

interface UseFaceDetectionOptions {
  onScore?: (score: number) => void;
  targetRatios: FaceRatios | null;
  active: boolean;
}

export function useFaceDetection({ onScore, targetRatios, active }: UseFaceDetectionOptions) {
  const [modelsReady, setModelsReady]   = useState(false);
  const [cameraReady, setCameraReady]   = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [similarity, setSimilarity]     = useState<number | null>(null);
  const [loadError, setLoadError]       = useState(false);

  const videoRef     = useRef<HTMLVideoElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement | null>(null);
  const streamRef    = useRef<MediaStream | null>(null);
  const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const detectingRef = useRef(false);

  // Store props in refs so detect() needs zero deps and the interval is
  // never torn down mid-round when active/targetRatios change.
  const targetRatiosRef = useRef(targetRatios);
  const activeRef       = useRef(active);
  const onScoreRef      = useRef(onScore);
  useEffect(() => { targetRatiosRef.current = targetRatios; }, [targetRatios]);
  useEffect(() => { activeRef.current = active; },             [active]);
  useEffect(() => { onScoreRef.current = onScore; },           [onScore]);

  // ── Load script + models ─────────────────────────────────────────────────────
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

  // ── Camera ───────────────────────────────────────────────────────────────────
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

          const video = videoRef.current;
          if (video) {
            video.srcObject = stream;
            try { await video.play(); } catch { /* autoplay policy — ok */ }
          }

          if (!canvasRef.current) {
            const cv = document.createElement("canvas");
            cv.width  = 224;
            cv.height = 168;
            canvasRef.current = cv;
          }

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
  }, [modelsReady]);

  // ── Detection loop ───────────────────────────────────────────────────────────
  // Empty dep array is intentional — everything is read from refs so this
  // function reference never changes and the interval never restarts mid-round.
  const detect = useCallback(async () => {
    if (detectingRef.current) return;

    const video = videoRef.current;
    if (!video || !window.faceapi) return;
    if (video.readyState < 2) return;

    // iOS can power-throttle paused video; un-pause and skip this tick
    if (video.paused || video.ended) {
      try { await video.play(); } catch { /* ignore */ }
      return;
    }

    detectingRef.current = true;
    try {
      // Draw to canvas before inference. iOS WebGL backend can produce black/stale
      // frames when reading directly from a <video> element; canvas is always current.
      let input: HTMLCanvasElement | HTMLVideoElement = video;
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          input = canvas;
        }
      }

      const result = await window.faceapi
        .detectSingleFace(
          input,
          new window.faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.35 }),
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
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [cameraReady, detect]); // detect is stable — this runs exactly once

  return { videoRef, modelsReady, cameraReady, faceDetected, similarity, loadError };
}
