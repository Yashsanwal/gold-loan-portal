import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, sql, type SQL } from "drizzle-orm";
import {
  STATUS_TRANSITIONS,
  bpsToPercent,
  formatDateIst,
  gramsToMg,
  maskMobile,
  mgToGrams,
  paiseToRupees,
  quotePlan,
  valueGold,
  type ApiErrorBody,
  type CreateLeadResponse,
  type Karat,
  type LeadDetailResponse,
  type LeadListResponse,
  type LeadRequest,
  type LeadSource,
  type LeadStatus,
  type LeadView,
  type StatusUpdate,
} from "@goldloan/shared";
import type { AppDb } from "../db/client.js";
import { idempotencyKeys, leadAuditLog, leads, loanSchemes, type LeadRow } from "../db/schema.js";
import { AppError, notFound } from "../errors.js";
import type { GoldRateService } from "./gold-rate.js";
import type { SchemeService } from "./schemes.js";

// Namespaces for pg_advisory_xact_lock(int, int), so the two lock families never collide.
const LOCK_IDEMPOTENCY = 1;
const LOCK_MOBILE = 2;

export interface CreateLeadOptions {
  source: LeadSource;
  idempotencyKey?: string;
}

export type CreateLeadResult =
  | { status: 201; body: CreateLeadResponse; replayed: boolean }
  | { status: 409; body: ApiErrorBody; replayed: boolean };

export interface ExistingApplication {
  applicationId: string;
  status: LeadStatus;
  createdAt: Date;
}

export interface ListLeadsQuery {
  page: number;
  pageSize: number;
  planId?: string;
  status?: LeadStatus;
}

type LeadWithPlan = LeadRow & { planName: string };

type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
type Executor = AppDb | Tx;

export function toLeadView(row: LeadWithPlan): LeadView {
  return {
    applicationId: row.applicationId,
    fullName: row.fullName,
    mobileNumber: maskMobile(row.mobileNumber),
    grossWeightGrams: mgToGrams(row.grossWeightMg),
    netWeightGrams: mgToGrams(row.netWeightMg),
    karat: row.karat as Karat,
    planId: row.planId,
    planName: row.planName,
    pureGoldGrams: mgToGrams(row.pureGoldMg),
    goldValue: paiseToRupees(row.goldValuePaise),
    eligibleLoan: paiseToRupees(row.eligibleLoanPaise),
    appliedLtvPercent: bpsToPercent(row.appliedLtvBps),
    rate24kPerGram: paiseToRupees(row.rate24kPaisePerGram),
    status: row.status,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function duplicateErrorBody(existing: ExistingApplication): ApiErrorBody {
  const on = formatDateIst(existing.createdAt);
  return {
    error: {
      code: "DUPLICATE_APPLICATION",
      message: `You already applied on ${on}, application ${existing.applicationId}. We allow one application per mobile number every 7 days.`,
      fields: [{ field: "mobileNumber", message: `Already used for ${existing.applicationId} on ${on}` }],
      details: {
        applicationId: existing.applicationId,
        submittedAt: existing.createdAt.toISOString(),
        status: existing.status,
      },
    },
  };
}

/** Stable hash of the normalised request, so a replayed key must carry the same payload. */
function hashRequest(input: LeadRequest, source: LeadSource): string {
  const canonical = JSON.stringify([
    source,
    input.fullName,
    input.mobileNumber,
    input.grossWeightGrams,
    input.netWeightGrams,
    input.karat,
    input.planId,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

const leadWithPlanColumns = {
  lead: leads,
  planName: loanSchemes.name,
};

function flatten(row: { lead: LeadRow; planName: string }): LeadWithPlan {
  return { ...row.lead, planName: row.planName };
}

export class LeadService {
  constructor(
    private readonly db: AppDb,
    private readonly schemes: SchemeService,
    private readonly goldRate: GoldRateService,
    private readonly settings: { duplicateWindowDays: number; idempotencyTtlHours: number },
  ) {}

  /**
   * The single write path for applications, shared by the form API and the agent.
   * Numbers are always recomputed here from the validated weights and the server's rate.
   */
  async create(input: LeadRequest, options: CreateLeadOptions): Promise<CreateLeadResult> {
    const scheme = await this.schemes.findActive(input.planId);
    if (!scheme) {
      throw notFound("PLAN_NOT_FOUND", `Loan plan "${input.planId}" does not exist`, [
        { field: "planId", message: "Choose one of the available plans" },
      ]);
    }

    const rate = await this.goldRate.current();
    const netWeightMg = gramsToMg(input.netWeightGrams);
    const valuation = valueGold({
      netWeightMg,
      karat: input.karat,
      rate24kPaisePerGram: rate.rate24kPaisePerGram,
    });
    const plan = quotePlan(valuation, scheme);
    const { idempotencyKey, source } = options;
    const requestHash = idempotencyKey ? hashRequest(input, source) : null;

    return this.db.transaction(async (tx) => {
      if (idempotencyKey && requestHash) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${sql.raw(String(LOCK_IDEMPOTENCY))}, hashtext(${idempotencyKey}))`,
        );
        const replay = await this.findReplay(tx, idempotencyKey, requestHash);
        if (replay) return replay;
      }

      // Serialises concurrent requests for one mobile number, so exactly one can insert.
      await tx.execute(
        sql`select pg_advisory_xact_lock(${sql.raw(String(LOCK_MOBILE))}, hashtext(${input.mobileNumber}))`,
      );

      const existing = await this.findRecentApplication(input.mobileNumber, tx);
      let result: CreateLeadResult;
      if (existing) {
        result = { status: 409, body: duplicateErrorBody(existing), replayed: false };
      } else {
        const [row] = await tx
          .insert(leads)
          .values({
            fullName: input.fullName,
            mobileNumber: input.mobileNumber,
            grossWeightMg: gramsToMg(input.grossWeightGrams),
            netWeightMg,
            karat: input.karat,
            planId: scheme.id,
            rate24kPaisePerGram: rate.rate24kPaisePerGram,
            pureGoldMg: valuation.pureGoldMg,
            goldValuePaise: valuation.goldValuePaise,
            appliedLtvBps: plan.appliedLtvBps,
            eligibleLoanPaise: plan.eligibleLoanRupees * 100,
            source,
          })
          .returning();
        if (!row) throw new Error("Insert returned no row");

        await tx.insert(leadAuditLog).values({
          leadId: row.id,
          fromStatus: null,
          toStatus: row.status,
          note: source === "AGENT" ? "Filed through Loan Assist" : "Filed through the web form",
          actor: source === "AGENT" ? "loan-assist" : "applicant",
        });

        const lead = toLeadView({ ...row, planName: scheme.name });
        result = {
          status: 201,
          body: { applicationId: lead.applicationId, status: lead.status, createdAt: lead.createdAt, lead },
          replayed: false,
        };
      }

      if (idempotencyKey && requestHash) {
        await tx.insert(idempotencyKeys).values({
          key: idempotencyKey,
          requestHash,
          responseStatus: result.status,
          responseBody: result.body,
        });
      }
      return result;
    });
  }

  private async findReplay(
    tx: Tx,
    key: string,
    requestHash: string,
  ): Promise<CreateLeadResult | null> {
    const [stored] = await tx.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)).limit(1);
    if (!stored) return null;

    const expiresAt = stored.createdAt.getTime() + this.settings.idempotencyTtlHours * 3_600_000;
    if (expiresAt <= Date.now()) {
      await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
      return null;
    }
    if (stored.requestHash !== requestHash) {
      throw new AppError(
        422,
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used with a different request body",
      );
    }
    if (stored.responseStatus === 201) {
      return { status: 201, body: stored.responseBody as CreateLeadResponse, replayed: true };
    }
    return { status: 409, body: stored.responseBody as ApiErrorBody, replayed: true };
  }

  /** Most recent application from this mobile inside the duplicate window, if any. */
  async findRecentApplication(
    mobileNumber: string,
    executor: Executor = this.db,
  ): Promise<ExistingApplication | null> {
    const [row] = await executor
      .select({ applicationId: leads.applicationId, status: leads.status, createdAt: leads.createdAt })
      .from(leads)
      .where(
        and(
          eq(leads.mobileNumber, mobileNumber),
          gt(leads.createdAt, sql`now() - make_interval(days => ${this.settings.duplicateWindowDays})`),
        ),
      )
      .orderBy(desc(leads.createdAt))
      .limit(1);
    return row ?? null;
  }

  async list(query: ListLeadsQuery): Promise<LeadListResponse> {
    const filters: SQL[] = [];
    if (query.planId) filters.push(eq(leads.planId, query.planId));
    if (query.status) filters.push(eq(leads.status, query.status));
    const where = filters.length > 0 ? and(...filters) : undefined;

    const [rows, totals] = await Promise.all([
      this.db
        .select(leadWithPlanColumns)
        .from(leads)
        .innerJoin(loanSchemes, eq(leads.planId, loanSchemes.id))
        .where(where)
        .orderBy(desc(leads.createdAt), desc(leads.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db.select({ total: count() }).from(leads).where(where),
    ]);

    const total = totals[0]?.total ?? 0;
    return {
      data: rows.map((row) => toLeadView(flatten(row))),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  async get(applicationId: string): Promise<LeadDetailResponse> {
    const [row] = await this.db
      .select(leadWithPlanColumns)
      .from(leads)
      .innerJoin(loanSchemes, eq(leads.planId, loanSchemes.id))
      .where(eq(leads.applicationId, applicationId))
      .limit(1);
    if (!row) throw notFound("LEAD_NOT_FOUND", `Application ${applicationId} was not found`);

    const audit = await this.db
      .select()
      .from(leadAuditLog)
      .where(eq(leadAuditLog.leadId, row.lead.id))
      .orderBy(asc(leadAuditLog.createdAt), asc(leadAuditLog.id));

    return {
      lead: toLeadView(flatten(row)),
      audit: audit.map((entry) => ({
        id: entry.id,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        note: entry.note,
        actor: entry.actor,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  async updateStatus(applicationId: string, update: StatusUpdate, actor: string): Promise<LeadDetailResponse> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: leads.id, status: leads.status })
        .from(leads)
        .where(eq(leads.applicationId, applicationId))
        .for("update")
        .limit(1);
      if (!row) throw notFound("LEAD_NOT_FOUND", `Application ${applicationId} was not found`);

      const allowed = STATUS_TRANSITIONS[row.status];
      if (!allowed.includes(update.status)) {
        const options = allowed.length > 0 ? allowed.join(" or ") : "nothing (it is final)";
        throw new AppError(
          409,
          "INVALID_STATUS_TRANSITION",
          `Cannot move an application from ${row.status} to ${update.status}. It can only move to ${options}.`,
          [{ field: "status", message: `Not allowed from ${row.status}` }],
          { currentStatus: row.status, allowed },
        );
      }

      await tx
        .update(leads)
        .set({ status: update.status, updatedAt: sql`now()` })
        .where(eq(leads.id, row.id));
      await tx.insert(leadAuditLog).values({
        leadId: row.id,
        fromStatus: row.status,
        toStatus: update.status,
        note: update.note ?? null,
        actor,
      });
    });
    return this.get(applicationId);
  }
}
