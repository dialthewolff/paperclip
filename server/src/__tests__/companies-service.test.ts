import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  agentWakeupRequests,
  budgetIncidents,
  budgetPolicies,
  builtInManagedResources,
  companies,
  companySkillVersions,
  companySkills,
  companyMemberships,
  costEvents,
  createDb,
  financeEvents,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  principalPermissionGrants,
  projects,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";
import { readBuiltInAgentMarker } from "../services/built-in-agent-metadata.js";
import { reconcileBuiltInAgentsOnStartup } from "../services/built-in-agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(builtInManagedResources);
    await db.delete(companySkillVersions);
    await db.delete(companySkills);
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentConfigRevisions);
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("retries generated issue prefixes when Drizzle wraps the unique constraint error", async () => {
    await db.insert(companies).values({
      name: "Aron Existing",
      issuePrefix: "ARO",
    });

    const created = await companyService(db).create({
      name: "Aron & Sharon",
    });

    expect(created.issuePrefix).toBe("AROA");

    const rows = await db.select({ issuePrefix: companies.issuePrefix }).from(companies);
    expect(rows.map((row) => row.issuePrefix).sort()).toEqual(["ARO", "AROA"]);
  });

  it("removes a populated company in foreign-key-safe order without touching another company", async () => {
    const now = new Date("2026-07-30T00:00:00Z");

    const createPopulatedCompany = async (
      companyId: string,
      issuePrefix: string,
      status: "active" | "archived",
    ) => {
      const managerAgentId = randomUUID();
      const workerAgentId = randomUUID();
      const parentGoalId = randomUUID();
      const goalId = randomUUID();
      const projectId = randomUUID();
      const runId = randomUUID();
      const costEventId = randomUUID();
      const budgetPolicyId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: `${issuePrefix} Company`,
        status,
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: managerAgentId,
        companyId,
        name: `${issuePrefix} Manager`,
        role: "manager",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(agents).values({
        id: workerAgentId,
        companyId,
        name: `${issuePrefix} Worker`,
        role: "engineer",
        status: "terminated",
        reportsTo: managerAgentId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      await db.insert(goals).values({
        id: parentGoalId,
        companyId,
        title: `${issuePrefix} Parent Goal`,
        ownerAgentId: managerAgentId,
      });
      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: `${issuePrefix} Child Goal`,
        parentId: parentGoalId,
        ownerAgentId: workerAgentId,
      });

      await db.insert(projects).values({
        id: projectId,
        companyId,
        goalId,
        leadAgentId: workerAgentId,
        name: `${issuePrefix} Project`,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: workerAgentId,
        invocationSource: "on_demand",
        status: "succeeded",
        startedAt: now,
        finishedAt: now,
      });

      await db.insert(heartbeatRunEvents).values({
        companyId,
        runId,
        agentId: workerAgentId,
        seq: 1,
        eventType: "lifecycle",
        message: "completed",
      });

      await db.insert(costEvents).values({
        id: costEventId,
        companyId,
        agentId: workerAgentId,
        projectId,
        goalId,
        heartbeatRunId: runId,
        provider: "test",
        biller: "test",
        billingType: "test",
        costStatus: "reported",
        model: "test-model",
        costCents: 1,
        occurredAt: now,
      });

      await db.insert(financeEvents).values({
        companyId,
        agentId: workerAgentId,
        projectId,
        goalId,
        heartbeatRunId: runId,
        costEventId,
        eventKind: "agent_cost",
        biller: "test",
        amountCents: 1,
        occurredAt: now,
      });

      await db.insert(budgetPolicies).values({
        id: budgetPolicyId,
        companyId,
        scopeType: "company",
        scopeId: companyId,
        windowKind: "monthly",
        amount: 100,
      });

      await db.insert(budgetIncidents).values({
        companyId,
        policyId: budgetPolicyId,
        scopeType: "company",
        scopeId: companyId,
        metric: "billed_cents",
        windowKind: "monthly",
        windowStart: now,
        windowEnd: new Date("2026-08-01T00:00:00Z"),
        thresholdType: "hard_stop",
        amountLimit: 100,
        amountObserved: 101,
      });
    };

    type CompanyRowCounts = {
      companyCount: number;
      agentCount: number;
      goalCount: number;
      projectCount: number;
      heartbeatRunCount: number;
      heartbeatEventCount: number;
      costEventCount: number;
      financeEventCount: number;
      budgetPolicyCount: number;
      budgetIncidentCount: number;
    };
    const readCompanyRowCounts = async (companyId: string) => {
      const rows = Array.from(await db.execute<CompanyRowCounts>(sql`
        SELECT
          (SELECT count(*)::int FROM companies WHERE id = ${companyId}) AS "companyCount",
          (SELECT count(*)::int FROM agents WHERE company_id = ${companyId}) AS "agentCount",
          (SELECT count(*)::int FROM goals WHERE company_id = ${companyId}) AS "goalCount",
          (SELECT count(*)::int FROM projects WHERE company_id = ${companyId}) AS "projectCount",
          (SELECT count(*)::int FROM heartbeat_runs WHERE company_id = ${companyId}) AS "heartbeatRunCount",
          (SELECT count(*)::int FROM heartbeat_run_events WHERE company_id = ${companyId}) AS "heartbeatEventCount",
          (SELECT count(*)::int FROM cost_events WHERE company_id = ${companyId}) AS "costEventCount",
          (SELECT count(*)::int FROM finance_events WHERE company_id = ${companyId}) AS "financeEventCount",
          (SELECT count(*)::int FROM budget_policies WHERE company_id = ${companyId}) AS "budgetPolicyCount",
          (SELECT count(*)::int FROM budget_incidents WHERE company_id = ${companyId}) AS "budgetIncidentCount"
      `));
      return rows[0]!;
    };

    const targetCompanyId = randomUUID();
    const controlCompanyId = randomUUID();
    await createPopulatedCompany(targetCompanyId, "TARG", "archived");
    await createPopulatedCompany(controlCompanyId, "CTRL", "active");

    const removed = await companyService(db).remove(targetCompanyId);

    expect(removed?.id).toBe(targetCompanyId);
    expect(await readCompanyRowCounts(targetCompanyId)).toEqual({
      companyCount: 0,
      agentCount: 0,
      goalCount: 0,
      projectCount: 0,
      heartbeatRunCount: 0,
      heartbeatEventCount: 0,
      costEventCount: 0,
      financeEventCount: 0,
      budgetPolicyCount: 0,
      budgetIncidentCount: 0,
    });
    expect(await readCompanyRowCounts(controlCompanyId)).toEqual({
      companyCount: 1,
      agentCount: 2,
      goalCount: 2,
      projectCount: 1,
      heartbeatRunCount: 1,
      heartbeatEventCount: 1,
      costEventCount: 1,
      financeEventCount: 1,
      budgetPolicyCount: 1,
      budgetIncidentCount: 1,
    });
  });

  it("rolls back when another company references a target-company agent", async () => {
    const targetCompanyId = randomUUID();
    const controlCompanyId = randomUUID();
    const targetAgentId = randomUUID();
    const controlAgentId = randomUUID();

    await db.insert(companies).values([
      {
        id: targetCompanyId,
        name: "Cross Company Target",
        status: "archived",
        issuePrefix: "XCT",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: controlCompanyId,
        name: "Cross Company Control",
        status: "active",
        issuePrefix: "XCC",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: targetAgentId,
      companyId: targetCompanyId,
      name: "Target Manager",
      role: "manager",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agents).values({
      id: controlAgentId,
      companyId: controlCompanyId,
      name: "Control Worker",
      role: "engineer",
      status: "terminated",
      reportsTo: targetAgentId,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await expect(companyService(db).remove(targetCompanyId)).rejects.toThrow();

    const companyRows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, targetCompanyId));
    const targetAgentRows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, targetAgentId));
    const controlAgentRows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, controlAgentId));
    expect(companyRows).toHaveLength(1);
    expect(targetAgentRows).toHaveLength(1);
    expect(controlAgentRows).toHaveLength(1);
  });

  it("rejects a non-company-owned table that blocks a company-owned table", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const externalReferenceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "External Blocker Target",
      status: "archived",
      issuePrefix: "EBT",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Externally Referenced Agent",
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.execute(sql`
      CREATE TABLE company_delete_external_agent_refs (
        id uuid PRIMARY KEY,
        agent_id uuid NOT NULL REFERENCES agents(id)
      )
    `);

    try {
      await db.execute(sql`
        INSERT INTO company_delete_external_agent_refs (id, agent_id)
        VALUES (${externalReferenceId}, ${agentId})
      `);

      await expect(companyService(db).remove(companyId)).rejects.toThrow(
        /non-company-owned table public\.company_delete_external_agent_refs/,
      );

      const companyRows = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId));
      const agentRows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agentId));
      const externalRows = Array.from(await db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM company_delete_external_agent_refs
      `));
      expect(companyRows).toHaveLength(1);
      expect(agentRows).toHaveLength(1);
      expect(externalRows[0]?.count).toBe(1);
    } finally {
      await db.execute(sql`DROP TABLE IF EXISTS company_delete_external_agent_refs`);
    }
  });

  it("rejects a non-cascading cycle between company-owned tables", async () => {
    const companyId = randomUUID();
    const leftId = randomUUID();
    const rightId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Cycle Target",
      status: "archived",
      issuePrefix: "CYT",
      requireBoardApprovalForNewAgents: false,
    });
    await db.execute(sql`
      CREATE TABLE company_delete_cycle_left (
        id uuid PRIMARY KEY,
        company_id uuid NOT NULL REFERENCES companies(id),
        right_id uuid
      )
    `);
    await db.execute(sql`
      CREATE TABLE company_delete_cycle_right (
        id uuid PRIMARY KEY,
        company_id uuid NOT NULL REFERENCES companies(id),
        left_id uuid REFERENCES company_delete_cycle_left(id)
      )
    `);
    await db.execute(sql`
      ALTER TABLE company_delete_cycle_left
      ADD CONSTRAINT company_delete_cycle_left_right_fk
      FOREIGN KEY (right_id) REFERENCES company_delete_cycle_right(id)
    `);

    try {
      await db.execute(sql`
        INSERT INTO company_delete_cycle_left (id, company_id)
        VALUES (${leftId}, ${companyId})
      `);
      await db.execute(sql`
        INSERT INTO company_delete_cycle_right (id, company_id, left_id)
        VALUES (${rightId}, ${companyId}, ${leftId})
      `);
      await db.execute(sql`
        UPDATE company_delete_cycle_left SET right_id = ${rightId} WHERE id = ${leftId}
      `);

      await expect(companyService(db).remove(companyId)).rejects.toThrow(
        /non-cascading foreign key cycle/,
      );

      const companyRows = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId));
      const cycleRows = Array.from(await db.execute<{ leftCount: number; rightCount: number }>(sql`
        SELECT
          (SELECT count(*)::int FROM company_delete_cycle_left) AS "leftCount",
          (SELECT count(*)::int FROM company_delete_cycle_right) AS "rightCount"
      `));
      expect(companyRows).toHaveLength(1);
      expect(cycleRows[0]).toEqual({ leftCount: 1, rightCount: 1 });
    } finally {
      await db.execute(sql`
        DROP TABLE IF EXISTS company_delete_cycle_left, company_delete_cycle_right CASCADE
      `);
    }
  });

  it("discovers and safely quotes a newly added company-owned table", async () => {
    const companyId = randomUUID();
    const oddRowId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Quoted Identifier Target",
      status: "archived",
      issuePrefix: "QIT",
      requireBoardApprovalForNewAgents: false,
    });
    await db.execute(sql`
      CREATE TABLE "company_delete_odd.rows" (
        id uuid PRIMARY KEY,
        company_id uuid NOT NULL REFERENCES companies(id),
        payload text NOT NULL
      )
    `);

    try {
      await db.execute(sql`
        INSERT INTO "company_delete_odd.rows" (id, company_id, payload)
        VALUES (${oddRowId}, ${companyId}, 'quoted')
      `);

      const removed = await companyService(db).remove(companyId);

      const oddRows = Array.from(await db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM "company_delete_odd.rows"
      `));
      expect(removed?.id).toBe(companyId);
      expect(oddRows[0]?.count).toBe(0);
    } finally {
      await db.execute(sql`DROP TABLE IF EXISTS "company_delete_odd.rows"`);
    }
  });

  it("auto-provisions one paused Reflection Coach bundle for a freshly created company", async () => {
    const created = await companyService(db).create({
      name: "Fresh Company",
    });

    const agentRows = await db.select().from(agents).where(eq(agents.companyId, created.id));
    const reflectionRows = agentRows.filter((row) => readBuiltInAgentMarker(row.metadata)?.key === "reflection-coach");
    expect(reflectionRows).toHaveLength(1);
    expect(reflectionRows[0]).toMatchObject({
      name: "Reflection Coach",
      status: "paused",
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
    });

    const [skill] = await db
      .select()
      .from(companySkills)
      .where(and(
        eq(companySkills.companyId, created.id),
        eq(companySkills.key, "paperclipai/bundled/paperclip-operations/reflection-coach"),
      ));
    expect(skill).toMatchObject({
      slug: "reflection-coach",
    });

    const [routine] = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, created.id), eq(routines.assigneeAgentId, reflectionRows[0]!.id)));
    expect(routine).toMatchObject({
      status: "paused",
      assigneeAgentId: reflectionRows[0]!.id,
      originKind: "built_in_agent_bundle",
      originId: "reflection-coach:recent-agent-reflection",
    });
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine!.id));
    expect(trigger).toMatchObject({
      kind: "schedule",
      enabled: false,
    });

    await reconcileBuiltInAgentsOnStartup(db);
    const afterReconcileRows = await db.select().from(agents).where(eq(agents.companyId, created.id));
    expect(afterReconcileRows.filter((row) => readBuiltInAgentMarker(row.metadata)?.key === "reflection-coach")).toHaveLength(1);
  });

  it("archives companies by pausing runnable agents and cancelling active runs", async () => {
    const companyId = randomUUID();
    const runningAgentId = randomUUID();
    const idleAgentId = randomUUID();
    const errorAgentId = randomUUID();
    const pausedAgentId = randomUUID();
    const pendingAgentId = randomUUID();
    const terminatedAgentId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Archive Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: runningAgentId,
        companyId,
        name: "Running Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: idleAgentId,
        companyId,
        name: "Idle Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: errorAgentId,
        companyId,
        name: "Error Agent",
        role: "engineer",
        status: "error",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pausedAgentId,
        companyId,
        name: "Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending Agent",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: terminatedAgentId,
        companyId,
        name: "Terminated Agent",
        role: "engineer",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: runningAgentId,
      source: "timer",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: runningAgentId,
      invocationSource: "timer",
      status: "running",
      wakeupRequestId,
    });

    const archived = await companyService(db).archive(companyId, {
      actorType: "user",
      actorId: "test-user",
      agentId: null,
      runId: null,
    });

    expect(archived?.status).toBe("archived");

    const archiveActivity = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({
      actorType: "user",
      actorId: "test-user",
      details: { agentsPaused: 3, runsCancelled: 1 },
    });

    const rows = await db
      .select({
        id: agents.id,
        status: agents.status,
        pauseReason: agents.pauseReason,
      })
      .from(agents);

    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(runningAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(idleAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(errorAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(pausedAgentId)).toMatchObject({ status: "paused", pauseReason: "manual" });
    expect(byId.get(pendingAgentId)).toMatchObject({ status: "pending_approval", pauseReason: null });
    expect(byId.get(terminatedAgentId)).toMatchObject({ status: "terminated", pauseReason: null });

    const run = await db
      .select({
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .then((result) => result[0] ?? null);
    expect(run).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });

    const wakeup = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .then((result) => result[0] ?? null);
    expect(wakeup).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });
  });

  it("reactivates only agents paused because the company was archived", async () => {
    const companyId = randomUUID();
    const archivedPausedAgentId = randomUUID();
    const manualPausedAgentId = randomUUID();
    const pendingAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reactivate Test Co",
      status: "archived",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: archivedPausedAgentId,
        companyId,
        name: "Archived Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: manualPausedAgentId,
        companyId,
        name: "Manual Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending Approval Agent",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const reactivateActivity = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(1);
    expect(reactivateActivity[0]).toMatchObject({
      actorType: "user",
      actorId: "test-user",
      details: { agentsRestored: 1 },
    });

    const rows = await db
      .select({
        id: agents.id,
        status: agents.status,
        pauseReason: agents.pauseReason,
        pausedAt: agents.pausedAt,
      })
      .from(agents);

    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(archivedPausedAgentId)).toMatchObject({
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    });
    expect(byId.get(manualPausedAgentId)).toMatchObject({
      status: "paused",
      pauseReason: "manual",
    });
    expect(byId.get(pendingAgentId)).toMatchObject({
      status: "pending_approval",
      pauseReason: null,
    });
  });

  it("runs the archive cascade when update() transitions a company to archived", async () => {
    const companyId = randomUUID();
    const runningAgentId = randomUUID();
    const idleAgentId = randomUUID();
    const pendingAgentId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Update Archive Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: runningAgentId,
        companyId,
        name: "Running Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: idleAgentId,
        companyId,
        name: "Idle Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending Agent",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: runningAgentId,
      source: "timer",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: runningAgentId,
      invocationSource: "timer",
      status: "running",
      wakeupRequestId,
    });

    const archived = await companyService(db).update(
      companyId,
      { status: "archived" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(archived?.status).toBe("archived");

    const rows = await db
      .select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(runningAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(idleAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(pendingAgentId)).toMatchObject({ status: "pending_approval", pauseReason: null });

    const run = await db
      .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .then((result) => result[0] ?? null);
    expect(run).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });

    const archiveActivity = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({
      actorType: "user",
      actorId: "test-user",
      details: { agentsPaused: 2, runsCancelled: 1 },
    });
  });

  it("reactivates company_archived agents even when going via paused state (archived → paused → active)", async () => {
    const companyId = randomUUID();
    const archivedPausedAgentId = randomUUID();
    const manualPausedAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Indirect Reactivate Test Co",
      status: "paused",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: archivedPausedAgentId,
        companyId,
        name: "Archived Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: manualPausedAgentId,
        companyId,
        name: "Manual Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const rows = await db
      .select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(archivedPausedAgentId)).toMatchObject({ status: "idle", pauseReason: null });
    expect(byId.get(manualPausedAgentId)).toMatchObject({ status: "paused", pauseReason: "manual" });

    const reactivateActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(1);
    expect(reactivateActivity[0]).toMatchObject({ details: { agentsRestored: 1 } });
  });

  it("emits company.reactivated for archived → active even when no agents need restoring", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Empty Reactivate Co",
      status: "archived",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: terminatedAgentId,
      companyId,
      name: "Terminated Agent",
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const reactivateActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(1);
    expect(reactivateActivity[0]).toMatchObject({ details: { agentsRestored: 0 } });
  });

  it("does not emit company.reactivated when paused → active restores no archive-paused agents", async () => {
    const companyId = randomUUID();
    const manualPausedAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plain Unpause Co",
      status: "paused",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: manualPausedAgentId,
      companyId,
      name: "Manual Paused Agent",
      role: "engineer",
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date("2026-06-01T00:00:00Z"),
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const reactivateActivity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(0);

    const agent = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .then((rows) => rows[0] ?? null);
    expect(agent).toMatchObject({ status: "paused", pauseReason: "manual" });
  });

  it("cancels orphan queued wakeup requests with no runId during archive", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const orphanWakeupId = randomUUID();
    const runWakeupId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Orphan Wakeup Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Idle Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values([
      {
        id: orphanWakeupId,
        companyId,
        agentId,
        source: "automation",
        status: "queued",
      },
      {
        id: runWakeupId,
        companyId,
        agentId,
        source: "timer",
        status: "queued",
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "running",
      wakeupRequestId: runWakeupId,
    });

    const archived = await companyService(db).archive(companyId, {
      actorType: "user",
      actorId: "test-user",
      agentId: null,
      runId: null,
    });
    expect(archived?.status).toBe("archived");

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests);
    const byId = new Map(wakeups.map((row) => [row.id, row]));
    expect(byId.get(orphanWakeupId)).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });
    expect(byId.get(runWakeupId)).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });
  });

  it("archive() is idempotent — re-archiving emits no second cascade or activity entry", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Idempotent Archive Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Idle Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const actor = { actorType: "user" as const, actorId: "test-user", agentId: null, runId: null };
    const first = await companyService(db).archive(companyId, actor);
    expect(first?.status).toBe("archived");

    const second = await companyService(db).archive(companyId, actor);
    expect(second?.status).toBe("archived");

    const archiveActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({ details: { agentsPaused: 1, runsCancelled: 0 } });
  });

  it("runs the archive cascade when update() transitions a paused company to archived", async () => {
    const companyId = randomUUID();
    const idleAgentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paused To Archived Test Co",
      status: "paused",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: idleAgentId,
      companyId,
      name: "Idle Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: idleAgentId,
      invocationSource: "timer",
      status: "queued",
    });

    const archived = await companyService(db).update(
      companyId,
      { status: "archived" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(archived?.status).toBe("archived");

    const agent = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .then((rows) => rows[0] ?? null);
    expect(agent).toMatchObject({ status: "paused", pauseReason: "company_archived" });

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("cancelled");

    const archiveActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({
      details: { agentsPaused: 1, runsCancelled: 1 },
    });
  });
});
