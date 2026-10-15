import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { InboxItemView } from "@aihxm/shared-types";
import type { RequestClaims } from "../database/tenant-context";

export type WorkflowOutcomeEvent = "approved" | "rejected" | "returned" | "cancelled" | "resubmitted";

export type WorkflowOutcomeContext = {
  client: PoolClient;
  claims: RequestClaims;
  instanceId: string;
  objectKey: string;
  recordId: string;
  event: WorkflowOutcomeEvent;
  comment: string | null;
};

/**
 * Gap Register WFL-01. A module that owns an approvable record registers an
 * adapter so the engine and My Inbox can drive it without knowing its tables.
 *
 *  onOutcome    runs INSIDE the engine's decision transaction when an instance
 *               ends (approved / rejected / returned / cancelled) or is
 *               resubmitted - the domain effect and the workflow state commit
 *               together or not at all.
 *  legacyDecide for modules that predate the engine hook and apply their effect
 *               in their own decide(): My Inbox calls that method instead of the
 *               engine directly, so there is still one approval center.
 *  describe     title / summary / deep link shown in the inbox.
 *  listTasks    non-approval work items (e.g. onboarding tasks) shown in the inbox.
 */
export interface WorkflowObjectAdapter {
  objectKey: string;
  label: string;
  canSendBack?: boolean;
  onOutcome?(ctx: WorkflowOutcomeContext): Promise<void>;
  legacyDecide?(claims: RequestClaims, recordId: string, dto: { decision: "approved" | "rejected"; comment?: string }): Promise<unknown>;
  describe?(client: PoolClient, recordId: string): Promise<{ title?: string; summary?: string; deepLink?: string } | null>;
  listTasks?(client: PoolClient, claims: RequestClaims): Promise<InboxItemView[]>;
}

@Injectable()
export class WorkflowAdapterRegistry {
  private readonly adapters = new Map<string, WorkflowObjectAdapter>();

  register(adapter: WorkflowObjectAdapter): void {
    this.adapters.set(adapter.objectKey, adapter);
  }

  get(objectKey: string): WorkflowObjectAdapter | undefined {
    return this.adapters.get(objectKey);
  }

  all(): WorkflowObjectAdapter[] {
    return [...this.adapters.values()];
  }
}
