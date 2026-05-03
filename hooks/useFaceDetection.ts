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

interface UseFaceDetectionOptions {
  onScore?: (score: number) => void;
  targetRatios: FaceRatios | null;
  active: boolean; // only run detection when a round is active
}

export function useFaceDetection({ onScore, targetRatios, active }: UseFaceDetectionOptions) {
  const [modelsReady, setModelsReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [similarity, setSimilarity] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load face-api.js
  useEffect(() => {
    if (typeof window === "undefined") return;
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
    script.async = true;
    script.onload = async () => {
      try {
        const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model";
        await window.faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await window.faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);
        setModelsReady(true);
      } catch (e) {
        console.error("Model load failed", e);
        setLoadError(true);
      }
    };
    script.onerror = () => setLoadError(true);
    document.head.appendChild(script);
    return () => {
      if (document.head.contains(script)) document.head.removeChild(script);
    };
  }, []);

  // Start camera
  useEffect(() => {
    if (!modelsReady) return;
    navigator.mediaDevices.getUserMedia({
      video: { width: 480, height: 360, facingMode: "user" },
      audio: false,
    }).then((stream) => {
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraReady(true);
    }).catch(() => setLoadError(true));

    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [modelsReady]);

  // Detection loop
  const detect = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !window.faceapi) return;
    const result = await window.faceapi
      .detectSingleFace(video, new window.faceapi.TinyFaceDetectorOptions({ inputSize: 224 }))
      .withFaceLandmarks(true);
    if (!result) {
      setFaceDetected(false);
      setSimilarity(null);
      return;
    }
    setFaceDetected(true);
    if (targetRatios && active) {
      const score = ratioSimilarity(computeRatios(result.landmarks.positions), targetRatios);
      setSimilarity(score);
      onScore?.(score);
    }
  }, [targetRatios, active, onScore]);

  useEffect(() => {
    if (!cameraReady) return;
    intervalRef.current = setInterval(detect, 300);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [cameraReady, detect]);

  return { videoRef, modelsReady, cameraReady, faceDetected, similarity, loadError };
}
