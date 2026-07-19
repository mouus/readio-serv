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

if (!process.env.DATABASE_URL) {
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

/*
 * Cleans extracted text.
 *
 * unpdf returns:
 * - one string when mergePages is true
 * - an array of page strings when mergePages is false
 */
const cleanExtractedText = (
  value
) => {
  const rawText =
    Array.isArray(value)
      ? value
          .filter(
            (item) =>
              typeof item ===
              "string"
          )
          .join("\n\n")
      : typeof value ===
          "string"
        ? value
        : "";

  return rawText
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

/*
 * Checks whether the uploaded buffer
 * looks like a real PDF.
 */
const isPdfBuffer = (
  buffer
) => {
  if (
    !Buffer.isBuffer(
      buffer
    ) ||
    buffer.length < 5
  ) {
    return false;
  }

  /*
   * Most PDFs start with %PDF-.
   *
   * Some valid PDFs have a few bytes
   * before the header, so inspect the
   * first 1 KB.
   */
  const beginning =
    buffer
      .subarray(
        0,
        Math.min(
          buffer.length,
          1024
        )
      )
      .toString(
        "latin1"
      );

  return beginning.includes(
    "%PDF-"
  );
};

/*
 * Extracts text directly from the
 * Multer memory buffer.
 *
 * S3 is not involved in extraction.
 */
const extractPdfTextFromBuffer =
  async (
    pdfBuffer
  ) => {
    if (
      !isPdfBuffer(
        pdfBuffer
      )
    ) {
      throw new Error(
        "The uploaded file does not contain a valid PDF header."
      );
    }

    /*
     * Always create a fresh byte array.
     *
     * This prevents PDF.js from sharing or
     * modifying the same memory later used
     * for the S3 upload.
     */
    const createPdfBytes =
      () =>
        Uint8Array.from(
          pdfBuffer
        );

    let pdf =
      null;

    let totalPages =
      0;

    let mergedExtractionError =
      null;

    try {
      /*
       * First attempt:
       * create a PDF document proxy.
       */
      pdf =
        await getDocumentProxy(
          createPdfBytes()
        );

      totalPages =
        Number(
          pdf.numPages ||
            0
        );

      /*
       * First extraction method:
       * merge all pages into one string.
       */
      try {
        const mergedResult =
          await extractText(
            pdf,
            {
              mergePages:
                true,
            }
          );

        totalPages =
          Number(
            mergedResult
              .totalPages ||
              totalPages ||
              0
          );

        const mergedText =
          cleanExtractedText(
            mergedResult.text
          );

        if (mergedText) {
          return {
            text:
              mergedText,

            totalPages,

            method:
              "merged",
          };
        }
      } catch (error) {
        mergedExtractionError =
          error;

        console.error(
          "Merged PDF extraction failed:",
          {
            name:
              error?.name,

            message:
              error?.message,
          }
        );
      }

      /*
       * Second extraction method:
       * extract one string per page.
       */
      try {
        const pageResult =
          await extractText(
            pdf,
            {
              mergePages:
                false,
            }
          );

        totalPages =
          Number(
            pageResult
              .totalPages ||
              totalPages ||
              0
          );

        const pageText =
          cleanExtractedText(
            pageResult.text
          );

        return {
          text:
            pageText,

          totalPages,

          method:
            "pages",
        };
      } catch (pageError) {
        console.error(
          "Page-by-page PDF extraction failed:",
          {
            name:
              pageError?.name,

            message:
              pageError?.message,
          }
        );

        /*
         * Throw the more recent error,
         * unless only the merged method failed.
         */
        throw (
          pageError ||
          mergedExtractionError
        );
      }
    } catch (proxyError) {
      console.error(
        "PDF proxy extraction failed:",
        {
          name:
            proxyError?.name,

          message:
            proxyError?.message,
        }
      );

      /*
       * Final fallback:
       *
       * unpdf can also extract directly
       * from raw PDF bytes without manually
       * creating a document proxy.
       */
      const fallbackResult =
        await extractText(
          createPdfBytes(),
          {
            mergePages:
              false,
          }
        );

      const fallbackText =
        cleanExtractedText(
          fallbackResult.text
        );

      return {
        text:
          fallbackText,

        totalPages:
          Number(
            fallbackResult
              .totalPages ||
              totalPages ||
              0
          ),

        method:
          "raw-bytes",
      };
    } finally {
      if (
        pdf &&
        typeof pdf.destroy ===
          "function"
      ) {
        try {
          await pdf.destroy();
        } catch (
          destroyError
        ) {
          console.warn(
            "Could not destroy PDF proxy:",
            destroyError
          );
        }
      }
    }
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
 * in req.body.
 *
 * GET and DELETE requests send
 * clerkUuid in req.query.
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
       * filename and file_url contain
       * the private S3 object key.
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
       * Temporary private S3 URL.
       */
      url:
        signedUrl,

      /*
       * The frontend turns this relative
       * path into a complete backend URL.
       */
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

    return rows.length > 0;
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

/*
 * POST /api/documents/upload
 */
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

      /*
       * Multer memoryStorage places
       * the uploaded PDF here.
       */
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

      let extractionMethod =
        null;

      let extractionError =
        null;

      /*
       * Extract text before uploading
       * the PDF buffer to S3.
       */
      try {
        const extraction =
          await extractPdfTextFromBuffer(
            pdfBuffer
          );

        extractedText =
          extraction.text;

        totalPages =
          extraction.totalPages;

        extractionMethod =
          extraction.method;

        console.log(
          "PDF text extraction result:",
          {
            pages:
              totalPages,

            characters:
              extractedText.length,

            method:
              extractionMethod,

            hasText:
              extractedText.length >
              0,
          }
        );

        if (!extractedText) {
          extractionError =
            "The PDF was uploaded, but it does not contain an extractable text layer. It may be scanned or image-only.";
        }
      } catch (error) {
        console.error(
          "PDF text extraction error:",
          {
            name:
              error?.name,

            message:
              error?.message,

            stack:
              error?.stack,
          }
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

      /*
       * Upload the original PDF buffer
       * to private Amazon S3 storage.
       */
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

          extractionMethod,
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

          extraction: {
            success:
              extractedText.length >
              0,

            characters:
              extractedText.length,

            pages:
              totalPages,

            method:
              extractionMethod,

            message:
              extractionError,
          },

          document,
        });
    } catch (error) {
      console.error(
        "Upload document error:",
        error
      );

      /*
       * If S3 upload succeeded but the
       * Neon insert failed, remove the
       * unfinished S3 object.
       */
      if (uploadedS3Key) {
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

/*
 * GET /api/documents
 */
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
            (row) =>
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

/*
 * GET /api/documents/:id
 */
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

/*
 * GET /api/documents/:id/text
 */
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

/*
 * DELETE /api/documents/:id
 */
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
       * Read the S3 key before deleting
       * the Neon document row.
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

      /*
       * Delete the actual PDF from S3.
       */
      await removeS3Object(
        s3Key
      );

      /*
       * Delete its metadata and extracted
       * text from Neon.
       */
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

/*
 * GET /api/documents/health
 */
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