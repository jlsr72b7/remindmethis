ALTER TABLE "public"."User"
ADD COLUMN "mobileNumberVerifiedAt" TIMESTAMP(3),
ADD COLUMN "mobileVerificationCode" TEXT,
ADD COLUMN "mobileVerificationCodeExpiresAt" TIMESTAMP(3);
