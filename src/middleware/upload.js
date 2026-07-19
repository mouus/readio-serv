import crypto from "node:crypto";

import multer from "multer";

const MAX_FILE_SIZE =
  25 * 1024 * 1024;

const storage =
  multer.memoryStorage();

const fileFilter = (
  req,
  file,
  callback
) => {
  const isPdfMimeType =
    file.mimetype ===
    "application/pdf";

  const isPdfExtension =
    file.originalname
      ?.toLowerCase()
      .endsWith(".pdf");

  if (
    !isPdfMimeType ||
    !isPdfExtension
  ) {
    return callback(
      new Error(
        "Only PDF files are allowed."
      )
    );
  }

  callback(
    null,
    true
  );
};

export const uploadPdf =
  multer({
    storage,

    fileFilter,

    limits: {
      fileSize:
        MAX_FILE_SIZE,

      files: 1,
    },
  });

/*
 * Optional helper if anything else in
 * your project still expects req.documentId.
 */
export const createDocumentId = (
  req,
  res,
  next
) => {
  req.documentId =
    crypto.randomUUID();

  next();
};