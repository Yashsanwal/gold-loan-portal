CREATE TYPE "public"."lead_source" AS ENUM('FORM', 'AGENT');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."repayment_type" AS ENUM('BULLET', 'EMI');--> statement-breakpoint
CREATE SEQUENCE "public"."application_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1001 CACHE 1;--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"from_status" "lead_status",
	"to_status" "lead_status" NOT NULL,
	"note" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" text DEFAULT ('GL-' || nextval('application_number_seq')) NOT NULL,
	"full_name" text NOT NULL,
	"mobile_number" text NOT NULL,
	"gross_weight_mg" integer NOT NULL,
	"net_weight_mg" integer NOT NULL,
	"karat" smallint NOT NULL,
	"plan_id" text NOT NULL,
	"rate_24k_paise_per_gram" bigint NOT NULL,
	"pure_gold_mg" integer NOT NULL,
	"gold_value_paise" bigint NOT NULL,
	"applied_ltv_bps" integer NOT NULL,
	"eligible_loan_paise" bigint NOT NULL,
	"status" "lead_status" DEFAULT 'SUBMITTED' NOT NULL,
	"source" "lead_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_application_id_unique" UNIQUE("application_id"),
	CONSTRAINT "leads_weights_check" CHECK ("leads"."net_weight_mg" > 0 AND "leads"."net_weight_mg" <= "leads"."gross_weight_mg" AND "leads"."gross_weight_mg" <= 1000000),
	CONSTRAINT "leads_karat_check" CHECK ("leads"."karat" IN (18, 22, 24)),
	CONSTRAINT "leads_ltv_check" CHECK ("leads"."applied_ltv_bps" > 0 AND "leads"."applied_ltv_bps" <= 7500),
	CONSTRAINT "leads_mobile_check" CHECK ("leads"."mobile_number" ~ '^[6-9][0-9]{9}$')
);
--> statement-breakpoint
CREATE TABLE "loan_schemes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"repayment_type" "repayment_type" NOT NULL,
	"annual_interest_rate_bps" integer NOT NULL,
	"tenure_months" integer NOT NULL,
	"max_ltv_bps" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_schemes_max_ltv_check" CHECK ("loan_schemes"."max_ltv_bps" > 0 AND "loan_schemes"."max_ltv_bps" <= 7500),
	CONSTRAINT "loan_schemes_rate_check" CHECK ("loan_schemes"."annual_interest_rate_bps" >= 0),
	CONSTRAINT "loan_schemes_tenure_check" CHECK ("loan_schemes"."tenure_months" > 0)
);
--> statement-breakpoint
ALTER TABLE "lead_audit_log" ADD CONSTRAINT "lead_audit_log_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_plan_id_loan_schemes_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."loan_schemes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_audit_lead_idx" ON "lead_audit_log" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_mobile_created_idx" ON "leads" USING btree ("mobile_number","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_created_idx" ON "leads" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_plan_idx" ON "leads" USING btree ("plan_id");