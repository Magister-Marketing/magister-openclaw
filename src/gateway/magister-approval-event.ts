type ApprovalEvent = {
  approval_id: string;
  operation_id: string;
  state: "pending";
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  const direct = asRecord(value);
  if (!direct) {
    return undefined;
  }
  const content = direct.content;
  if (!Array.isArray(content) || content.length !== 1) {
    return direct;
  }
  const item = asRecord(content[0]);
  return item?.type === "text" ? parseJsonObject(item.text) : undefined;
}

/**
 * Extract the only successful-tool detail allowed onto the web-chat wire.
 * Ordinary successful bodies stay private; a closed Magister approval
 * envelope contributes three opaque identifiers and nothing else. Held
 * approvals arrive as a progress update before their eventual terminal tool
 * result so the card can render while the original call is still waiting.
 */
export function extractMagisterApprovalEvent(params: {
  phase: unknown;
  name: unknown;
  isError: unknown;
  result: unknown;
}): ApprovalEvent | undefined {
  if (
    (params.phase !== "result" && params.phase !== "update") ||
    params.isError === true ||
    typeof params.name !== "string" ||
    !/^magister_[a-z0-9_]+$/.test(params.name)
  ) {
    return undefined;
  }
  const envelope = parseJsonObject(params.result);
  const status = asRecord(envelope?.status);
  const error = asRecord(envelope?.error);
  const receipt = asRecord(envelope?.receipt);
  const approvalId = receipt?.approval_id;
  const operationId = envelope?.operation_id;
  if (
    envelope?.ok !== false ||
    status?.state !== "running" ||
    status.terminal !== false ||
    (error?.code !== "approval_required" && error?.code !== "not_authorized") ||
    error.retryable !== false ||
    receipt?.approval_state !== "pending" ||
    receipt.approval_presentation !== "inline_web" ||
    typeof approvalId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      approvalId,
    ) ||
    typeof operationId !== "string" ||
    !/^op_[a-f0-9]{32}$/.test(operationId)
  ) {
    return undefined;
  }
  return {
    approval_id: approvalId.toLowerCase(),
    operation_id: operationId,
    state: "pending",
  };
}

export function extractMagisterApprovalEventFromToolEvent(
  data: Record<string, unknown>,
): ApprovalEvent | undefined {
  return extractMagisterApprovalEvent({
    phase: data.phase,
    name: data.name,
    isError: data.isError,
    result: data.phase === "update" ? data.partialResult : data.result,
  });
}
