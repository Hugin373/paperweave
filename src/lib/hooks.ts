"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";
import type { AiConfigDto, CollectionSummary, MeResponse, TagSummary } from "./types";

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api<MeResponse>("/api/me") });
}

export function useAiConfig() {
  return useQuery({ queryKey: ["ai-config"], queryFn: () => api<AiConfigDto>("/api/ai/config"), staleTime: 60_000 });
}

/** True when an AI provider is configured and enabled for the workspace. */
export function useAiEnabled() {
  const { data } = useAiConfig();
  return !!data?.configured && !!data.enabled;
}

export function useCollections() {
  return useQuery({ queryKey: ["collections"], queryFn: () => api<CollectionSummary[]>("/api/collections") });
}

export function useTags() {
  return useQuery({ queryKey: ["tags"], queryFn: () => api<TagSummary[]>("/api/tags") });
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
