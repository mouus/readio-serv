import {
  neon,
} from "@neondatabase/serverless";

import fs from "node:fs/promises";
import path from "node:path";

import {
  extractText,
  getDocumentProxy,
} from "unpdf";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is missing from the backend .env file."
  );
}

const sql = neon(
  process.env.DATABASE_URL
);

const cleanExtractedText = (
  value
) => {
  if (
    typeof value !== "string"
  ) {
    return "";
  }

  return value
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const calculateDocumentStats = (
  text
) => {
  const words = text
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
              wordCount / 150
            )
          )
        : 0,
  };
};

const getBaseUrl = (
  req
) => {
  return (
    process.env
      .PUBLIC_SERVER_URL ||
    `${req.protocol}://${req.get(
      "host"
    )}`
  );
};

/*
 * Upload requests send clerkUuid in req.body.
 * GET and DELETE requests send it in req.query.
 */
const getClerkUuid = (
  req
) => {
  const bodyValue =
    typeof req.body?.clerkUuid ===
      "string"
      ? req.body.clerkUuid.trim()
      : "";

  const queryValue =
    typeof req.query?.clerkUuid ===
      "string"
      ? req.query.clerkUuid.trim()
      : "";

  return bodyValue || queryValue;
};

const formatDocument = (
  row,
  baseUrl
) => {
  return {
    id: row.id,

    clerkUuid:
      row.clerk_uuid,

    name: row.name,

    filename:
      row.filename,

    mimeType:
      row.mime_type,

    size: Number(
      row.size_bytes || 0
    ),

    url:
      `${baseUrl}/uploads/` +
      encodeURIComponent(
        row.filename
      ),

    textUrl:
      `${baseUrl}/api/documents/` +
      `${encodeURIComponent(
        row.id
      )}/text?clerkUuid=${encodeURIComponent(
        row.clerk_uuid
      )}`,

    pages: Number(
      row.pages || 0
    ),

    wordCount: Number(
      row.word_count || 0
    ),

    estimatedMinutes:
      Number(
        row.estimated_minutes ||
          0
      ),

    hasText: Boolean(
      row.has_text
    ),

    preview:
      row.preview || "",

    createdAt:
      row.created_at instanceof
      Date
        ? row.created_at.toISOString()
        : row.created_at,

    updatedAt:
      row.updated_at instanceof
      Date
        ? row.updated_at.toISOString()
        : row.updated_at,
  };
};

const userExists =
  async (
    clerkUuid
  ) => {
    const rows = await sql`
      SELECT
        clerk_uuid
      FROM users
      WHERE clerk_uuid =
        ${clerkUuid}
      LIMIT 1
    `;

    return rows.length > 0;
  };

export const uploadDocument =
  async (
    req,
    res,
    next
  ) => {
    try {
      if (
        !req.file ||
        !req.documentId
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Please upload a PDF file.",
          });
      }

      const clerkUuid =
        getClerkUuid(req);

      if (!clerkUuid) {
        if (req.file?.path) {
          await fs
            .unlink(
              req.file.path
            )
            .catch(() => {});
        }

        return res
          .status(400)
          .json({
            success: false,
            message:
              "A Clerk UUID is required.",
          });
      }

      const exists =
        await userExists(
          clerkUuid
        );

      if (!exists) {
        if (req.file?.path) {
          await fs
            .unlink(
              req.file.path
            )
            .catch(() => {});
        }

        return res
          .status(404)
          .json({
            success: false,
            message:
              "User not found. Sync the Clerk user before uploading a PDF.",
          });
      }

      const documentId =
        req.documentId;

      const pdfPath =
        req.file.path;

      const pdfBuffer =
        await fs.readFile(
          pdfPath
        );

      let extractedText = "";
      let totalPages = 0;
      let extractionError = null;

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
              mergePages: true,
            }
          );

        totalPages =
          Number(
            result.totalPages ||
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
          "The PDF was saved, but its text could not be extracted.";
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

      console.log(
        "Saving document to Neon:",
        {
          id: documentId,
          clerkUuid,
          name:
            req.file.originalname,
          filename:
            req.file.filename,
          pages:
            totalPages,
          wordCount,
        }
      );

      const rows = await sql`
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
          ${req.file.originalname},
          ${req.file.filename},
          ${req.file.mimetype},
          ${req.file.size},
          ${`/uploads/${req.file.filename}`},
          ${extractedText},
          ${preview},
          ${totalPages},
          ${wordCount},
          ${estimatedMinutes},
          ${
            extractedText.length >
            0
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

      const baseUrl =
        getBaseUrl(req);

      return res
        .status(201)
        .json({
          success: true,

          message:
            extractionError ||
            "PDF uploaded and saved successfully.",

          document:
            formatDocument(
              rows[0],
              baseUrl
            ),
        });
    } catch (error) {
      console.error(
        "Upload document error:",
        error
      );

      if (req.file?.path) {
        await fs
          .unlink(
            req.file.path
          )
          .catch(() => {});
      }

      if (
        error?.code ===
        "23505"
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "This PDF already exists.",
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
            success: false,
            message:
              "A Clerk UUID is required.",
          });
      }

      const rows = await sql`
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

      const baseUrl =
        getBaseUrl(req);

      const documents =
        rows.map(
          (row) =>
            formatDocument(
              row,
              baseUrl
            )
        );

      return res
        .status(200)
        .json({
          success: true,

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
            success: false,
            message:
              "A Clerk UUID is required.",
          });
      }

      const rows = await sql`
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
          id = ${req.params.id}
          AND clerk_uuid =
            ${clerkUuid}
        LIMIT 1
      `;

      if (!rows.length) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "Document not found.",
          });
      }

      const baseUrl =
        getBaseUrl(req);

      return res
        .status(200)
        .json({
          success: true,

          document:
            formatDocument(
              rows[0],
              baseUrl
            ),
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
            success: false,
            message:
              "A Clerk UUID is required.",
          });
      }

      const rows = await sql`
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
          id = ${req.params.id}
          AND clerk_uuid =
            ${clerkUuid}
        LIMIT 1
      `;

      if (!rows.length) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "Document text not found.",
          });
      }

      const document =
        rows[0];

      return res
        .status(200)
        .json({
          success: true,

          document: {
            id:
              document.id,

            clerkUuid:
              document.clerk_uuid,

            name:
              document.name,

            pages: Number(
              document.pages ||
                0
            ),

            wordCount: Number(
              document.word_count ||
                0
            ),

            estimatedMinutes:
              Number(
                document
                  .estimated_minutes ||
                  0
              ),

            hasText: Boolean(
              document.has_text
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
            success: false,
            message:
              "A Clerk UUID is required.",
          });
      }

      const rows = await sql`
        DELETE FROM documents
        WHERE
          id = ${req.params.id}
          AND clerk_uuid =
            ${clerkUuid}
        RETURNING
          id,
          filename
      `;

      if (!rows.length) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "Document not found.",
          });
      }

      const filePath =
        path.resolve(
          "uploads",
          rows[0].filename
        );

      await fs
        .unlink(filePath)
        .catch((error) => {
          if (
            error.code !==
            "ENOENT"
          ) {
            console.error(
              "PDF deletion error:",
              error
            );
          }
        });

      return res
        .status(200)
        .json({
          success: true,
          message:
            "Document deleted.",
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
      const result = await sql`
        SELECT
          NOW() AS database_time
      `;

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Readio server is running.",

          database:
            "connected",

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
          success: false,

          message:
            "Readio is running, but Neon is unavailable.",

          database:
            "disconnected",

          timestamp:
            new Date()
              .toISOString(),
        });
    }
  };