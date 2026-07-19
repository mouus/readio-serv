import dotenv from "dotenv";
dotenv.config();
import {
  S3Client,
} from "@aws-sdk/client-s3";

const awsRegion =
  process.env.AWS_REGION;

const bucketName =
  process.env.AWS_S3_BUCKET_NAME;

if (!awsRegion) {
  throw new Error(
    "AWS_REGION is missing from the backend environment variables."
  );
}

if (!bucketName) {
  throw new Error(
    "AWS_S3_BUCKET_NAME is missing from the backend environment variables."
  );
}

/*
 * The AWS SDK automatically reads:
 *
 * AWS_ACCESS_KEY_ID
 * AWS_SECRET_ACCESS_KEY
 *
 * from your Render environment variables.
 */
export const s3Client =
  new S3Client({
    region: awsRegion,
  });

export const s3BucketName =
  bucketName;

export const s3Region =
  awsRegion;