ALTER TABLE "public"."Event"
ADD COLUMN "rsvpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "rsvpByDate" TIMESTAMP(3);

CREATE TABLE "public"."RsvpInvite" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RsvpInvite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."RsvpResponse" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "response" TEXT NOT NULL,
    "message" TEXT,
    "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RsvpResponse_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RsvpInvite_eventId_idx" ON "public"."RsvpInvite"("eventId");

CREATE INDEX "RsvpResponse_eventId_idx" ON "public"."RsvpResponse"("eventId");

ALTER TABLE "public"."RsvpInvite" ADD CONSTRAINT "RsvpInvite_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."RsvpResponse" ADD CONSTRAINT "RsvpResponse_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
