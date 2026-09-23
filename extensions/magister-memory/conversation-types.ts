export type ConversationMemoryMode = "off" | "shadow" | "active";

export type ConversationCheckpointConfig = {
  mode: ConversationMemoryMode;
  model: string;
  idleMinutes: number;
  recentDays: number;
  maxInputChars: number;
  maxCheckpointChars: number;
  maxHeaderChars: number;
};

export type TranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  fingerprint: string;
};

export type CheckpointSummary = {
  summary: string;
  topics: string[];
  source: "model" | "fallback";
};

export type CheckpointRecord = {
  version: 1;
  checkpointId: string;
  sessionHash: string;
  sequence: number;
  startFingerprint: string;
  endFingerprint: string;
  createdAt: number;
  summary: string;
  topics: string[];
};

export type CheckpointInFlight = {
  checkpointId: string;
  entries: TranscriptEntry[];
  startedAt: number;
  sequence: number;
  startFingerprint: string;
  endFingerprint: string;
  prepared?: CheckpointSummary;
};

export type ConversationSessionState = {
  version: 1;
  sessionHash: string;
  agentId: string;
  lastMessageFingerprint?: string;
  lastMessageCount?: number;
  pending: TranscriptEntry[];
  pendingUserTurns: number;
  lastActivityAt: number;
  updatedAt: number;
  endedAt?: number;
  sequence: number;
  retryCount: number;
  retryAt?: number;
  previousSummary?: string;
  inFlight?: CheckpointInFlight;
  recallFrozen: boolean;
  frozenRecall?: string;
};
