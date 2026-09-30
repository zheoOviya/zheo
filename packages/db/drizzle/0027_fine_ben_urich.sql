CREATE TABLE IF NOT EXISTS "event_consumer_dedup" (
	"consumer_name" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_consumer_dedup_consumer_name_event_id_pk" PRIMARY KEY("consumer_name","event_id")
);
