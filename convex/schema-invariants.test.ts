import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  attentionNotificationFaultSlotsPerDelivery,
  maximumAttentionNotificationDeliveryAttempts,
} from "./attentionNotificationControl";
import schema from "./schema";
import { DETAIL_CHUNK_RETENTION, HOSTED_TABLE_LIFECYCLE } from "./lifecyclePolicy";
import { QUOTA_GENESIS_CHARGED_TABLES, USER_QUOTA_RESOURCES, USER_RESOURCE_QUOTAS } from "./quota";

describe("hosted schema invariants", () => {
  test("every hosted table and index name satisfies the provider identifier contract", () => {
    const providerIdentifier = /^[A-Za-z][A-Za-z0-9_]*$/u;
    const providerReservedIndexNames = new Set(["by_creation_time", "by_id"]);
    const tables = (schema as unknown as {
      readonly tables: Readonly<Record<string, unknown>>;
    }).tables;
    const indexSchema = z.object({ indexDescriptor: z.string() }).passthrough();
    const tableSchema = z.object({
      indexes: z.array(indexSchema),
      searchIndexes: z.array(indexSchema),
      stagedDbIndexes: z.array(indexSchema),
      stagedSearchIndexes: z.array(indexSchema),
      stagedVectorIndexes: z.array(indexSchema),
      vectorIndexes: z.array(indexSchema),
    }).passthrough();
    for (const [tableName, value] of Object.entries(tables)) {
      expect(tableName).toMatch(providerIdentifier);
      expect(tableName.length).toBeLessThanOrEqual(64);
      const table = tableSchema.parse(value);
      const indexNames = [
        ...table.indexes,
        ...table.searchIndexes,
        ...table.stagedDbIndexes,
        ...table.stagedSearchIndexes,
        ...table.stagedVectorIndexes,
        ...table.vectorIndexes,
      ]
        .map((index) => index.indexDescriptor);
      expect(new Set(indexNames).size).toBe(indexNames.length);
      for (const indexName of indexNames) {
        expect(indexName).toMatch(providerIdentifier);
        expect(indexName.length).toBeLessThanOrEqual(64);
        expect(providerReservedIndexNames.has(indexName)).toBeFalse();
      }
    }
  });

  test("every schema table has exactly one lifecycle, quota, retention, and erasure classification", () => {
    const schemaTables = Object.keys(schema.tables).sort();
    const classifiedTables = Object.keys(HOSTED_TABLE_LIFECYCLE).sort();
    expect(classifiedTables).toEqual(schemaTables);
    for (const table of classifiedTables) {
      const policy = HOSTED_TABLE_LIFECYCLE[table as keyof typeof HOSTED_TABLE_LIFECYCLE];
      expect(policy.owner.length).toBeGreaterThan(0);
      expect(policy.retention.length).toBeGreaterThan(0);
      expect(policy.disposition.length).toBeGreaterThan(0);
      if (policy.owner === "user") expect(policy.deletionOrder).not.toBeNull();
    }
  });

  test("auth verifiers are indexed by session for bounded account erasure", () => {
    const tables = (schema as unknown as { readonly tables: Readonly<Record<string, unknown>> }).tables;
    const table = z.object({
      indexes: z.array(z.object({ indexDescriptor: z.string() }).passthrough()),
    }).passthrough().parse(tables.authVerifiers);
    const indexes = table.indexes.map((index) => index.indexDescriptor);
    expect(indexes).toContain("sessionId");
  });

  test("attention notifications have every bounded lifecycle traversal index", () => {
    const tables = (schema as unknown as {
      readonly tables: Readonly<Record<string, unknown>>;
    }).tables;
    const table = z.object({
      indexes: z.array(z.object({ indexDescriptor: z.string() }).passthrough()),
    }).passthrough().parse(tables.attentionNotificationOutbox);
    const indexes = table.indexes.map((index) => index.indexDescriptor);
    for (const expected of [
      "by_delivery_id",
      "by_delivery_leader_row_id",
      "by_fault_capacity_anchor",
      "by_source_device_and_claimed_at",
      "by_source_device_nonterminal_and_revocation",
      "by_source_device_and_reconciliation",
      "by_state_and_claim_deadline",
      "by_state_and_cleanup_after",
      "by_state_and_coalesce_after",
      "by_state_and_delivery_deadline",
      "by_state_and_next_attempt_at",
      "by_user",
      "by_user_and_interaction",
      "by_user_and_claimed_at",
      "by_user_state_and_coalesce_after",
      "by_user_source_session_and_interaction",
    ]) expect(indexes).toContain(expected);
    expect(HOSTED_TABLE_LIFECYCLE.attentionNotificationOutbox).toEqual({
      deletionOrder: 10,
      disposition: "erase",
      owner: "user",
      quota: "command",
      retention: "attention_notification_7d",
    });
    expect(USER_QUOTA_RESOURCES).toContain("nonterminal_command");

    const faultTable = z.object({
      indexes: z.array(z.object({ indexDescriptor: z.string() }).passthrough()),
    }).passthrough().parse(tables.attentionNotificationSafetyFaults);
    const faultIndexes = faultTable.indexes.map((index) => index.indexDescriptor);
    for (const expected of [
      "by_anchor_and_slot",
      "by_cleanup_row",
      "by_delivery_and_state",
      "by_fault_id",
      "by_identity",
      "by_reason_quarantine_state_and_observed_at",
      "by_state_and_cleanup_after",
      "by_state_and_observed_at",
      "by_user",
    ]) expect(faultIndexes).toContain(expected);
    expect(HOSTED_TABLE_LIFECYCLE.attentionNotificationSafetyFaults).toEqual({
      deletionOrder: 10,
      disposition: "expire",
      owner: "service",
      quota: "security",
      retention: "attention_notification_7d",
    });
    expect(attentionNotificationFaultSlotsPerDelivery)
      .toBe(maximumAttentionNotificationDeliveryAttempts + 1);
  });

  test("immutable compact history is erased only through whole-account deletion", () => {
    expect(HOSTED_TABLE_LIFECYCLE.sessionChunks).toMatchObject({ retention: "encrypted_history", disposition: "erase" });
    expect(HOSTED_TABLE_LIFECYCLE.sessionStreamEpochs).toMatchObject({ retention: "encrypted_history", disposition: "erase" });
  });

  test("pre-live-tail quota upgrade can prove owner detail absence without scanning compact history", () => {
    const table = z.object({
      indexes: z.array(z.object({ indexDescriptor: z.string(), fields: z.array(z.string()) }).passthrough()),
    }).passthrough().parse(schema.tables.sessionChunks);
    expect(table.indexes.find((index) => index.indexDescriptor === "by_user_and_stream")?.fields)
      .toEqual(["userId", "stream"]);
  });

  test("live_tail is a distinct retention class from the table-wide compact history bulk class", () => {
    expect(DETAIL_CHUNK_RETENTION).toBe("live_tail");
    expect(DETAIL_CHUNK_RETENTION).not.toBe(HOSTED_TABLE_LIFECYCLE.sessionChunks.retention);
    expect(USER_QUOTA_RESOURCES).toContain("live_chunk");
    expect(USER_RESOURCE_QUOTAS.live_chunk).toBe(20_000);
    expect(USER_RESOURCE_QUOTAS.live_chunk).toBeLessThan(USER_RESOURCE_QUOTAS.session_chunk);
  });

  test("hard quota genesis proves every charged table empty", () => {
    const chargedTables = Object.entries(HOSTED_TABLE_LIFECYCLE)
      .filter(([, policy]) => policy.quota !== null)
      .map(([table]) => table)
      .sort();
    const genesisTables: string[] = [...QUOTA_GENESIS_CHARGED_TABLES].sort();
    expect(genesisTables).toEqual(chargedTables);
    expect(HOSTED_TABLE_LIFECYCLE.storageResourceUsageByUser.quota).toBeNull();
    expect(HOSTED_TABLE_LIFECYCLE.storageResourceUsageByAccount.quota).toBeNull();
    expect(HOSTED_TABLE_LIFECYCLE.serviceControl).toEqual({
      owner: "service",
      quota: null,
      retention: "service_permanent",
      deletionOrder: null,
      disposition: "service_reset",
    });
  });
});
