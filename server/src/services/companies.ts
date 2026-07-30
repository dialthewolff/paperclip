import { and, count, eq, gte, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  companyLogos,
  assets,
  agents,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  issues,
  issueComments,
  projects,
  goals,
  heartbeatRuns,
  heartbeatRunEvents,
  costEvents,
  financeEvents,
  issueReadStates,
  approvalComments,
  approvals,
  activityLog,
  companySecrets,
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
  companySkills,
  documents,
  routineRuns,
  routineTriggers,
  routineRevisions,
  routines,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { environmentService } from "./environments.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";
import { builtInAgentService } from "./built-in-agents.js";

export interface CompanyActivityActor {
  actorType: "user" | "agent" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

const SYSTEM_COMPANY_ACTOR: CompanyActivityActor = {
  actorType: "system",
  actorId: "system",
  agentId: null,
  runId: null,
};

export function companyService(db: Db) {
  const ISSUE_PREFIX_FALLBACK = "CMP";
  const environmentsSvc = environmentService(db);
  const heartbeat = heartbeatService(db);
  const builtInAgents = builtInAgentService(db);

  type CompanyTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  async function applyArchiveCascadeInTx(tx: CompanyTx, id: string) {
    const pausedAgentRows = await tx
      .update(agents)
      .set({
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agents.companyId, id),
        notInArray(agents.status, ["paused", "terminated", "pending_approval"]),
      ))
      .returning({ id: agents.id });

    const activeRunIds = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, id),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ))
      .then((rows) => rows.map((row) => row.id));

    await tx
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        error: "Cancelled because the company was archived",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentWakeupRequests.companyId, id),
        inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
        isNull(agentWakeupRequests.runId),
      ));

    return { agentsPaused: pausedAgentRows.length, activeRunIds };
  }

  async function finalizeArchive(
    id: string,
    actor: CompanyActivityActor,
    cascade: { agentsPaused: number; activeRunIds: string[] },
  ) {
    for (const runId of cascade.activeRunIds) {
      await heartbeat.cancelRun(runId, "Cancelled because the company was archived");
    }

    await logActivity(db, {
      companyId: id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "company.archived",
      entityType: "company",
      entityId: id,
      details: {
        agentsPaused: cascade.agentsPaused,
        runsCancelled: cascade.activeRunIds.length,
      },
    });
  }

  const companySelection = {
    id: companies.id,
    name: companies.name,
    description: companies.description,
    status: companies.status,
    issuePrefix: companies.issuePrefix,
    issueCounter: companies.issueCounter,
    budgetMonthlyCents: companies.budgetMonthlyCents,
    spentMonthlyCents: companies.spentMonthlyCents,
    attachmentMaxBytes: companies.attachmentMaxBytes,
    defaultResponsibleUserId: companies.defaultResponsibleUserId,
    requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents,
    feedbackDataSharingEnabled: companies.feedbackDataSharingEnabled,
    feedbackDataSharingConsentAt: companies.feedbackDataSharingConsentAt,
    feedbackDataSharingConsentByUserId: companies.feedbackDataSharingConsentByUserId,
    feedbackDataSharingTermsVersion: companies.feedbackDataSharingTermsVersion,
    brandColor: companies.brandColor,
    logoAssetId: companyLogos.assetId,
    createdAt: companies.createdAt,
    updatedAt: companies.updatedAt,
  };

  function enrichCompany<T extends { logoAssetId: string | null }>(company: T) {
    return {
      ...company,
      logoUrl: company.logoAssetId ? `/api/assets/${company.logoAssetId}/content` : null,
    };
  }

  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  async function getMonthlySpendByCompanyIds(
    companyIds: string[],
    database: Pick<Db, "select"> = db,
  ) {
    if (companyIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await database
        .select({
          companyId: costEvents.companyId,
          spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
      .from(costEvents)
      .where(
        and(
          inArray(costEvents.companyId, companyIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.companyId);
    return new Map(rows.map((row) => [row.companyId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateCompanySpend<T extends { id: string; spentMonthlyCents: number }>(
    rows: T[],
    database: Pick<Db, "select"> = db,
  ) {
    const spendByCompanyId = await getMonthlySpendByCompanyIds(rows.map((row) => row.id), database);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByCompanyId.get(row.id) ?? 0,
    }));
  }

  function getCompanyQuery(database: Pick<Db, "select">) {
    return database
      .select(companySelection)
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id));
  }

  function deriveIssuePrefixBase(name: string) {
    const normalized = name.toUpperCase().replace(/[^A-Z]/g, "");
    return normalized.slice(0, 3) || ISSUE_PREFIX_FALLBACK;
  }

  function suffixForAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return "A".repeat(attempt - 1);
  }

  function isIssuePrefixConflict(error: unknown) {
    const seen = new Set<unknown>();
    let current = error;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      const maybe = current as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
      const constraint = maybe.constraint ?? maybe.constraint_name;
      if (maybe.code === "23505" && constraint === "companies_issue_prefix_idx") {
        return true;
      }
      current = maybe.cause;
    }
    return false;
  }

  async function createCompanyWithUniquePrefix(data: typeof companies.$inferInsert) {
    const base = deriveIssuePrefixBase(data.name);
    let suffix = 1;
    while (suffix < 10000) {
      const candidate = `${base}${suffixForAttempt(suffix)}`;
      try {
        const rows = await db
          .insert(companies)
          .values({ ...data, issuePrefix: candidate })
          .returning();
        return rows[0];
      } catch (error) {
        if (!isIssuePrefixConflict(error)) throw error;
      }
      suffix += 1;
    }
    throw new Error("Unable to allocate unique issue prefix");
  }

  return {
    list: async () => {
      const rows = await getCompanyQuery(db);
      const hydrated = await hydrateCompanySpend(rows);
      return hydrated.map((row) => enrichCompany(row));
    },

    getById: async (id: string) => {
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    create: async (data: typeof companies.$inferInsert) => {
      const created = await createCompanyWithUniquePrefix(data);
      await environmentsSvc.ensureLocalEnvironment(created.id);
      await builtInAgents.autoProvisionBundledAgents(created.id);
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, created.id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Company not found after creation");
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    update: async (
      id: string,
      data: Partial<typeof companies.$inferInsert> & { logoAssetId?: string | null },
      actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR,
    ) => {
      const result = await db.transaction(async (tx) => {
        const existing = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const { logoAssetId, ...companyPatch } = data;
        const willReactivate = existing.status !== "active" && companyPatch.status === "active";
        const willArchive = existing.status !== "archived" && companyPatch.status === "archived";

        if (logoAssetId !== undefined && logoAssetId !== null) {
          const nextLogoAsset = await tx
            .select({ id: assets.id, companyId: assets.companyId })
            .from(assets)
            .where(eq(assets.id, logoAssetId))
            .then((rows) => rows[0] ?? null);
          if (!nextLogoAsset) throw notFound("Logo asset not found");
          if (nextLogoAsset.companyId !== existing.id) {
            throw unprocessable("Logo asset must belong to the same company");
          }
        }

        const updated = await tx
          .update(companies)
          .set({ ...companyPatch, updatedAt: new Date() })
          .where(eq(companies.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        let agentsRestored = 0;
        if (willReactivate) {
          const restoredRows = await tx
            .update(agents)
            .set({
              status: "idle",
              pauseReason: null,
              pausedAt: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(agents.companyId, id),
              eq(agents.status, "paused"),
              eq(agents.pauseReason, "company_archived"),
            ))
            .returning({ id: agents.id });
          agentsRestored = restoredRows.length;
        }

        const archiveCascade = willArchive ? await applyArchiveCascadeInTx(tx, id) : null;

        if (logoAssetId === null) {
          await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
        } else if (logoAssetId !== undefined) {
          await tx
            .insert(companyLogos)
            .values({
              companyId: id,
              assetId: logoAssetId,
            })
            .onConflictDoUpdate({
              target: companyLogos.companyId,
              set: {
                assetId: logoAssetId,
                updatedAt: new Date(),
              },
            });
        }

        if (logoAssetId !== undefined && existing.logoAssetId && existing.logoAssetId !== logoAssetId) {
          await tx.delete(assets).where(eq(assets.id, existing.logoAssetId));
        }

        const [hydrated] = await hydrateCompanySpend([{
          ...updated,
          logoAssetId: logoAssetId === undefined ? existing.logoAssetId : logoAssetId,
        }], tx);

        const shouldLogReactivation = willReactivate &&
          (existing.status === "archived" || agentsRestored > 0);

        return {
          company: enrichCompany(hydrated),
          reactivated: shouldLogReactivation ? { agentsRestored } : null,
          archiveCascade,
        };
      });
      if (!result) return null;
      if (result.reactivated) {
        await logActivity(db, {
          companyId: id,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          action: "company.reactivated",
          entityType: "company",
          entityId: id,
          details: { agentsRestored: result.reactivated.agentsRestored },
        });
      }
      if (result.archiveCascade) {
        await finalizeArchive(id, actor, result.archiveCascade);
      }
      return result.company;
    },

    archive: async (id: string, actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR) => {
      const result = await db.transaction(async (tx) => {
        const existing = await tx
          .select({ status: companies.status })
          .from(companies)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const wasAlreadyArchived = existing.status === "archived";

        if (!wasAlreadyArchived) {
          await tx
            .update(companies)
            .set({ status: "archived", updatedAt: new Date() })
            .where(eq(companies.id, id));
        }

        const cascade = wasAlreadyArchived ? null : await applyArchiveCascadeInTx(tx, id);

        const row = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!row) return null;
        const [hydrated] = await hydrateCompanySpend([row], tx);
        return {
          company: enrichCompany(hydrated),
          cascade,
        };
      });
      if (!result) return null;

      if (result.cascade) {
        await finalizeArchive(id, actor, result.cascade);
      }

      return result.company;
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        const lockedCompanyRows = Array.from(await tx.execute<{ id: string }>(sql`
          SELECT ${companies.id} AS id
          FROM ${companies}
          WHERE ${companies.id} = ${id}
          FOR UPDATE
        `));
        if (lockedCompanyRows.length === 0) return null;

        type CompanyOwnedTableRow = {
          schemaName: string;
          tableName: string;
          companyIdColumn: string;
        };
        type BlockingForeignKeyRow = {
          constraintName: string;
          childSchemaName: string;
          childTableName: string;
          parentSchemaName: string;
          parentTableName: string;
        };

        const ownedTables = Array.from(await tx.execute<CompanyOwnedTableRow>(sql`
          SELECT DISTINCT
            child_namespace.nspname AS "schemaName",
            child.relname AS "tableName",
            child_column.attname AS "companyIdColumn"
          FROM pg_constraint foreign_key
          JOIN pg_class child ON child.oid = foreign_key.conrelid
          JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
          JOIN pg_class parent ON parent.oid = foreign_key.confrelid
          JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
          JOIN LATERAL unnest(foreign_key.conkey) WITH ORDINALITY
            AS child_key(attnum, ordinal) ON true
          JOIN LATERAL unnest(foreign_key.confkey) WITH ORDINALITY
            AS parent_key(attnum, ordinal) ON parent_key.ordinal = child_key.ordinal
          JOIN pg_attribute child_column
            ON child_column.attrelid = child.oid
            AND child_column.attnum = child_key.attnum
          JOIN pg_attribute parent_column
            ON parent_column.attrelid = parent.oid
            AND parent_column.attnum = parent_key.attnum
          WHERE foreign_key.contype = 'f'
            AND parent_namespace.nspname = 'public'
            AND parent.relname = 'companies'
            AND parent_column.attname = 'id'
            AND child_column.attname = 'company_id'
          ORDER BY child_namespace.nspname, child.relname
        `));

        const blockingForeignKeys = Array.from(await tx.execute<BlockingForeignKeyRow>(sql`
          WITH company_owned_tables AS (
            SELECT DISTINCT child.oid
            FROM pg_constraint company_foreign_key
            JOIN pg_class child ON child.oid = company_foreign_key.conrelid
            JOIN pg_class company_table ON company_table.oid = company_foreign_key.confrelid
            JOIN pg_namespace company_namespace ON company_namespace.oid = company_table.relnamespace
            JOIN LATERAL unnest(company_foreign_key.conkey) WITH ORDINALITY
              AS child_key(attnum, ordinal) ON true
            JOIN LATERAL unnest(company_foreign_key.confkey) WITH ORDINALITY
              AS parent_key(attnum, ordinal) ON parent_key.ordinal = child_key.ordinal
            JOIN pg_attribute child_column
              ON child_column.attrelid = child.oid
              AND child_column.attnum = child_key.attnum
            JOIN pg_attribute parent_column
              ON parent_column.attrelid = company_table.oid
              AND parent_column.attnum = parent_key.attnum
            WHERE company_foreign_key.contype = 'f'
              AND company_namespace.nspname = 'public'
              AND company_table.relname = 'companies'
              AND parent_column.attname = 'id'
              AND child_column.attname = 'company_id'
          )
          SELECT DISTINCT
            foreign_key.conname AS "constraintName",
            child_namespace.nspname AS "childSchemaName",
            child.relname AS "childTableName",
            parent_namespace.nspname AS "parentSchemaName",
            parent.relname AS "parentTableName"
          FROM pg_constraint foreign_key
          JOIN pg_class child ON child.oid = foreign_key.conrelid
          JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
          JOIN pg_class parent ON parent.oid = foreign_key.confrelid
          JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
          JOIN company_owned_tables owned_parent ON owned_parent.oid = parent.oid
          WHERE foreign_key.contype = 'f'
            AND foreign_key.confdeltype IN ('a', 'r')
          ORDER BY child_namespace.nspname, child.relname, foreign_key.conname
        `));

        const tableKey = (schemaName: string, tableName: string) => `${schemaName}\u0000${tableName}`;
        const ownedTableByKey = new Map(
          ownedTables.map((table) => [tableKey(table.schemaName, table.tableName), table]),
        );
        const outgoingParents = new Map<string, Set<string>>();
        const incomingEdgeCount = new Map(
          ownedTables.map((table) => [tableKey(table.schemaName, table.tableName), 0]),
        );

        for (const foreignKey of blockingForeignKeys) {
          const childKey = tableKey(foreignKey.childSchemaName, foreignKey.childTableName);
          const parentKey = tableKey(foreignKey.parentSchemaName, foreignKey.parentTableName);
          if (!ownedTableByKey.has(childKey)) {
            throw new Error(
              `Cannot delete company: ${foreignKey.constraintName} references a company-owned table ` +
              `from non-company-owned table ${foreignKey.childSchemaName}.${foreignKey.childTableName}`,
            );
          }
          if (childKey === parentKey) {
            // A single table-wide DELETE removes same-company self-references together.
            // Any surviving cross-company reference still raises 23503 and rolls back this transaction.
            continue;
          }
          const parents = outgoingParents.get(childKey) ?? new Set<string>();
          if (!parents.has(parentKey)) {
            parents.add(parentKey);
            outgoingParents.set(childKey, parents);
            incomingEdgeCount.set(parentKey, (incomingEdgeCount.get(parentKey) ?? 0) + 1);
          }
        }

        const ready = Array.from(incomingEdgeCount.entries())
          .filter(([, count]) => count === 0)
          .map(([key]) => key)
          .sort();
        const deletionOrder: CompanyOwnedTableRow[] = [];

        while (ready.length > 0) {
          const key = ready.shift()!;
          deletionOrder.push(ownedTableByKey.get(key)!);
          for (const parentKey of Array.from(outgoingParents.get(key) ?? []).sort()) {
            const nextCount = (incomingEdgeCount.get(parentKey) ?? 0) - 1;
            incomingEdgeCount.set(parentKey, nextCount);
            if (nextCount === 0) {
              ready.push(parentKey);
              ready.sort();
            }
          }
        }

        if (deletionOrder.length !== ownedTables.length) {
          const cycleTables = Array.from(incomingEdgeCount.entries())
            .filter(([, count]) => count > 0)
            .map(([key]) => {
              const table = ownedTableByKey.get(key)!;
              return `${table.schemaName}.${table.tableName}`;
            })
            .sort();
          throw new Error(
            `Cannot delete company: non-cascading foreign key cycle among ${cycleTables.join(', ')}`,
          );
        }

        const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
        for (const table of deletionOrder) {
          const tableIdentifier = sql.raw(
            `${quoteIdentifier(table.schemaName)}.${quoteIdentifier(table.tableName)}`,
          );
          const companyIdColumn = sql.raw(quoteIdentifier(table.companyIdColumn));
          await tx.execute(sql`DELETE FROM ${tableIdentifier} WHERE ${companyIdColumn} = ${id}`);
        }

        const rows = await tx
          .delete(companies)
          .where(eq(companies.id, id))
          .returning();
        return rows[0] ?? null;
      }),

    stats: () =>
      Promise.all([
        db
          .select({ companyId: agents.companyId, count: count() })
          .from(agents)
          .groupBy(agents.companyId),
        db
          .select({ companyId: issues.companyId, count: count() })
          .from(issues)
          .groupBy(issues.companyId),
      ]).then(([agentRows, issueRows]) => {
        const result: Record<string, { agentCount: number; issueCount: number }> = {};
        for (const row of agentRows) {
          result[row.companyId] = { agentCount: row.count, issueCount: 0 };
        }
        for (const row of issueRows) {
          if (result[row.companyId]) {
            result[row.companyId].issueCount = row.count;
          } else {
            result[row.companyId] = { agentCount: 0, issueCount: row.count };
          }
        }
        return result;
      }),
  };
}
