import {
  neon,
} from "@neondatabase/serverless";

import crypto from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import {
  getSignedUrl,
} from "@aws-sdk/s3-request-presigner";

import {
  extractText,
  getDocumentProxy,
} from "unpdf";

import {
  s3BucketName,
  s3Client,
} from "../config/s3.js";

if (
  !process.env.DATABASE_URL
) {
  throw new Error(
    "DATABASE_URL is missing from the backend environment variables."
  );
}

const sql =
  neon(
    process.env.DATABASE_URL
  );

const SIGNED_URL_EXPIRATION =
  60 * 60;

const cleanExtractedText = (
  value
) => {
  if (
    typeof value !==
    "string"
  ) {
    return "";
  }

  return value
    .replace(
      /\u0000/g,
      ""
    )
    .replace(
      /\r/g,
      ""
    )
    .replace(
      /[ \t]+/g,
      " "
    )
    .replace(
      / *\n */g,
      "\n"
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
};

const calculateDocumentStats = (
  text
) => {
  const words =
    text
      .split(/\s+/)
      .filter(Boolean);

  const wordCount =
    words.length;

  return {
    wordCount,

    estimatedMinutes:
      wordCount > 0
        ? Math.max(
            1,
            Math.ceil(
              wordCount /
                150
            )
          )
        : 0,
  };
};

/*
 * Upload requests send clerkUuid
 * through req.body.
 *
 * GET and DELETE requests send
 * clerkUuid through req.query.
 */
const getClerkUuid = (
  req
) => {
  const bodyValue =
    typeof req.body
      ?.clerkUuid ===
    "string"
      ? req.body
          .clerkUuid
          .trim()
      : "";

  const queryValue =
    typeof req.query
      ?.clerkUuid ===
    "string"
      ? req.query
          .clerkUuid
          .trim()
      : "";

  return (
    bodyValue ||
    queryValue
  );
};

const sanitizeFileName = (
  fileName
) => {
  const fallbackName =
    "document.pdf";

  if (
    typeof fileName !==
      "string" ||
    !fileName.trim()
  ) {
    return fallbackName;
  }

  const cleaned =
    fileName
      .trim()
      .replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      )
      .replace(
        /_+/g,
        "_"
      );

  if (
    cleaned
      .toLowerCase()
      .endsWith(".pdf")
  ) {
    return cleaned;
  }

  return `${cleaned}.pdf`;
};

const createS3Key = ({
  clerkUuid,
  documentId,
  originalName,
}) => {
  const safeName =
    sanitizeFileName(
      originalName
    );

  return (
    `documents/` +
    `${clerkUuid}/` +
    `${documentId}-` +
    `${safeName}`
  );
};

const createSignedPdfUrl =
  async (
    s3Key,
    originalName
  ) => {
    if (!s3Key) {
      return null;
    }

    const safeName =
      sanitizeFileName(
        originalName
      );

    const command =
      new GetObjectCommand({
        Bucket:
          s3BucketName,

        Key:
          s3Key,

        ResponseContentType:
          "application/pdf",

        ResponseContentDisposition:
          `inline; filename="${safeName}"`,
      });

    return getSignedUrl(
      s3Client,
      command,
      {
        expiresIn:
          SIGNED_URL_EXPIRATION,
      }
    );
  };

const formatDocument =
  async (
    row
  ) => {
    const signedUrl =
      await createSignedPdfUrl(
        row.file_url,
        row.name
      );

    return {
      id:
        row.id,

      clerkUuid:
        row.clerk_uuid,

      name:
        row.name,

      /*
       * filename is now the S3 object key.
       */
      filename:
        row.filename,

      mimeType:
        row.mime_type,

      size:
        Number(
          row.size_bytes ||
            0
        ),

      /*
       * This is a private temporary S3 URL.
       * It expires after one hour.
       */
      url:
        signedUrl,

      textUrl:
        `/api/documents/` +
        `${encodeURIComponent(
          row.id
        )}/text?clerkUuid=${encodeURIComponent(
          row.clerk_uuid
        )}`,

      pages:
        Number(
          row.pages ||
            0
        ),

      wordCount:
        Number(
          row.word_count ||
            0
        ),

      estimatedMinutes:
        Number(
          row
            .estimated_minutes ||
            0
        ),

      hasText:
        Boolean(
          row.has_text
        ),

      preview:
        row.preview ||
        "",

      createdAt:
        row.created_at instanceof
        Date
          ? row.created_at
              .toISOString()
          : row.created_at,

      updatedAt:
        row.updated_at instanceof
        Date
          ? row.updated_at
              .toISOString()
          : row.updated_at,
    };
  };

const userExists =
  async (
    clerkUuid
  ) => {
    const rows =
      await sql`
        SELECT
          clerk_uuid
        FROM users
        WHERE clerk_uuid =
          ${clerkUuid}
        LIMIT 1
      `;

    return (
      rows.length > 0
    );
  };

const removeS3Object =
  async (
    s3Key
  ) => {
    if (!s3Key) {
      return;
    }

    await s3Client.send(
      new DeleteObjectCommand({
        Bucket:
          s3BucketName,

        Key:
          s3Key,
      })
    );
  };

export const uploadDocument =
  async (
    req,
    res,
    next
  ) => {
    let uploadedS3Key =
      null;

    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Please upload a PDF file.",
          });
      }

      const clerkUuid =
        getClerkUuid(req);

      if (!clerkUuid) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "A Clerk UUID is required.",
          });
      }

      const exists =
        await userExists(
          clerkUuid
        );

      if (!exists) {
        return res
          .status(404)
          .json({
            success:
              false,

            message:
              "User not found. Sync the Clerk user before uploading a PDF.",
          });
      }

      const documentId =
        req.documentId ||
        crypto.randomUUID();

      const pdfBuffer =
        req.file.buffer;

      if (
        !pdfBuffer ||
        !Buffer.isBuffer(
          pdfBuffer
        )
      ) {
        throw new Error(
          "The uploaded PDF buffer is unavailable."
        );
      }

      let extractedText =
        "";

      let totalPages =
        0;

      let extractionError =
        null;

      try {
        const pdf =
          await getDocumentProxy(
            new Uint8Array(
              pdfBuffer
            )
          );

        const result =
          await extractText(
            pdf,
            {
              mergePages:
                true,
            }
          );

        totalPages =
          Number(
            result
              .totalPages ||
              0
          );

        extractedText =
          cleanExtractedText(
            result.text
          );
      } catch (error) {
        console.error(
          "PDF text extraction error:",
          error
        );

        extractionError =
          "The PDF was uploaded, but its text could not be extracted.";
      }

      const {
        wordCount,
        estimatedMinutes,
      } =
        calculateDocumentStats(
          extractedText
        );

      const preview =
        extractedText.slice(
          0,
          500
        );

      uploadedS3Key =
        createS3Key({
          clerkUuid,

          documentId,

          originalName:
            req.file
              .originalname,
        });

      console.log(
        "Uploading PDF to S3:",
        {
          bucket:
            s3BucketName,

          key:
            uploadedS3Key,

          size:
            req.file.size,
        }
      );

      await s3Client.send(
        new PutObjectCommand({
          Bucket:
            s3BucketName,

          Key:
            uploadedS3Key,

          Body:
            pdfBuffer,

          ContentType:
            "application/pdf",

          ContentLength:
            req.file.size,

          ContentDisposition:
            `inline; filename="${sanitizeFileName(
              req.file
                .originalname
            )}"`,

          Metadata: {
            documentid:
              documentId,

            clerkuuid:
              clerkUuid,
          },
        })
      );

      console.log(
        "Saving document to Neon:",
        {
          id:
            documentId,

          clerkUuid,

          name:
            req.file
              .originalname,

          s3Key:
            uploadedS3Key,

          pages:
            totalPages,

          wordCount,
        }
      );

      const rows =
        await sql`
          INSERT INTO documents (
            id,
            clerk_uuid,
            name,
            filename,
            mime_type,
            size_bytes,
            file_url,
            extracted_text,
            preview,
            pages,
            word_count,
            estimated_minutes,
            has_text,
            created_at,
            updated_at
          )
          VALUES (
            ${documentId},
            ${clerkUuid},
            ${
              req.file
                .originalname
            },
            ${uploadedS3Key},
            ${
              req.file
                .mimetype
            },
            ${
              req.file
                .size
            },
            ${uploadedS3Key},
            ${extractedText},
            ${preview},
            ${totalPages},
            ${wordCount},
            ${
              estimatedMinutes
            },
            ${
              extractedText
                .length > 0
            },
            NOW(),
            NOW()
          )
          RETURNING *
        `;

      if (!rows.length) {
        throw new Error(
          "The document could not be saved to Neon."
        );
      }

      const document =
        await formatDocument(
          rows[0]
        );

      return res
        .status(201)
        .json({
          success:
            true,

          message:
            extractionError ||
            "PDF uploaded to S3 and saved successfully.",

          document,
        });
    } catch (error) {
      console.error(
        "Upload document error:",
        error
      );

      /*
       * If S3 succeeded but Neon failed,
       * remove the unfinished S3 object.
       */
      if (
        uploadedS3Key
      ) {
        try {
          await removeS3Object(
            uploadedS3Key
          );
        } catch (
          cleanupError
        ) {
          console.error(
            "S3 cleanup error:",
            cleanupError
          );
        }
      }

      if (
        error?.code ===
        "23505"
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            message:
              "This PDF already exists.",
          });
      }

      if (
        error?.name ===
          "EntityTooLarge" ||
        error?.code ===
          "LIMIT_FILE_SIZE"
      ) {
        return res
          .status(413)
          .json({
            success:
              false,

            message:
              "The PDF is too large. The maximum size is 25 MB.",
          });
      }

      next(error);
    }
  };

export const listDocuments =
  async (
    req,
    res,
    next
  ) => {
    try {
      const clerkUuid =
        getClerkUuid(req);

      if (!clerkUuid) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "A Clerk UUID is required.",
          });
      }

      const rows =
        await sql`
          SELECT
            id,
            clerk_uuid,
            name,
            filename,
            mime_type,
            size_bytes,
            file_url,
            preview,
            pages,
            word_count,
            estimated_minutes,
            has_text,
            created_at,
            updated_at
          FROM documents
          WHERE clerk_uuid =
            ${clerkUuid}
          ORDER BY
            created_at DESC
          LIMIT 100
        `;

      const documents =
        await Promise.all(
          rows.map(
            (
              row
            ) =>
              formatDocument(
                row
              )
          )
        );

      return res
        .status(200)
        .json({
          success:
            true,

          count:
            documents.length,

          documents,
        });
    } catch (error) {
      console.error(
        "List documents error:",
        error
      );

      next(error);
    }
  };

export const getDocument =
  async (
    req,
    res,
    next
  ) => {
    try {
      const clerkUuid =
        getClerkUuid(req);

      if (!clerkUuid) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "A Clerk UUID is required.",
          });
      }

      const rows =
        await sql`
          SELECT
            id,
            clerk_uuid,
            name,
            filename,
            mime_type,
            size_bytes,
            file_url,
            preview,
            pages,
            word_count,
            estimated_minutes,
            has_text,
            created_at,
            updated_at
          FROM documents
          WHERE
            id =
              ${req.params.id}
            AND clerk_uuid =
              ${clerkUuid}
          LIMIT 1
        `;

      if (!rows.length) {
        return res
          .status(404)
          .json({
            success:
              false,

            message:
              "Document not found.",
          });
      }

      const document =
        await formatDocument(
          rows[0]
        );

      return res
        .status(200)
        .json({
          success:
            true,

          document,
        });
    } catch (error) {
      console.error(
        "Get document error:",
        error
      );

      next(error);
    }
  };

export const getDocumentText =
  async (
    req,
    res,
    next
  ) => {
    try {
      const clerkUuid =
        getClerkUuid(req);

      if (!clerkUuid) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "A Clerk UUID is required.",
          });
      }

      const rows =
        await sql`
          SELECT
            id,
            clerk_uuid,
            name,
            pages,
            word_count,
            estimated_minutes,
            has_text,
            extracted_text
          FROM documents
          WHERE
            id =
              ${req.params.id}
            AND clerk_uuid =
              ${clerkUuid}
          LIMIT 1
        `;

      if (!rows.length) {
        return res
          .status(404)
          .json({
            success:
              false,

            message:
              "Document text not found.",
          });
      }

      const document =
        rows[0];

      return res
        .status(200)
        .json({
          success:
            true,

          document: {
            id:
              document.id,

            clerkUuid:
              document
                .clerk_uuid,

            name:
              document.name,

            pages:
              Number(
                document.pages ||
                  0
              ),

            wordCount:
              Number(
                document
                  .word_count ||
                  0
              ),

            estimatedMinutes:
              Number(
                document
                  .estimated_minutes ||
                  0
              ),

            hasText:
              Boolean(
                document
                  .has_text
              ),

            text:
              document
                .extracted_text ||
              "",
          },
        });
    } catch (error) {
      console.error(
        "Get document text error:",
        error
      );

      next(error);
    }
  };

export const deleteDocument =
  async (
    req,
    res,
    next
  ) => {
    try {
      const clerkUuid =
        getClerkUuid(req);

      if (!clerkUuid) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "A Clerk UUID is required.",
          });
      }

      /*
       * Get the S3 key before deleting
       * the Neon row.
       */
      const rows =
        await sql`
          SELECT
            id,
            filename,
            file_url
          FROM documents
          WHERE
            id =
              ${req.params.id}
            AND clerk_uuid =
              ${clerkUuid}
          LIMIT 1
        `;

      if (!rows.length) {
        return res
          .status(404)
          .json({
            success:
              false,

            message:
              "Document not found.",
          });
      }

      const document =
        rows[0];

      const s3Key =
        document.file_url ||
        document.filename;

      await removeS3Object(
        s3Key
      );

      await sql`
        DELETE FROM documents
        WHERE
          id =
            ${req.params.id}
          AND clerk_uuid =
            ${clerkUuid}
      `;

      return res
        .status(200)
        .json({
          success:
            true,

          message:
            "Document deleted from S3 and Neon.",
        });
    } catch (error) {
      console.error(
        "Delete document error:",
        error
      );

      next(error);
    }
  };

export const getServerHealth =
  async (
    req,
    res
  ) => {
    try {
      const result =
        await sql`
          SELECT
            NOW() AS database_time
        `;

      return res
        .status(200)
        .json({
          success:
            true,

          message:
            "Readio server is running.",

          database:
            "connected",

          storage:
            "Amazon S3",

          bucket:
            s3BucketName,

          databaseTime:
            result[0]
              .database_time,

          timestamp:
            new Date()
              .toISOString(),
        });
    } catch (error) {
      console.error(
        "Neon health error:",
        error
      );

      return res
        .status(503)
        .json({
          success:
            false,

          message:
            "Readio is running, but Neon is unavailable.",

          database:
            "disconnected",

          storage:
            "Amazon S3",

          timestamp:
            new Date()
              .toISOString(),
        });
    }
  };