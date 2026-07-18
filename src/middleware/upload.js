import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";

const uploadsDirectory = path.resolve("uploads");

fs.mkdirSync(uploadsDirectory, {
  recursive: true,
});

const storage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, uploadsDirectory);
  },

  filename: (req, file, callback) => {
    const id = crypto.randomUUID();

    const extension =
      path.extname(file.originalname).toLowerCase() || ".pdf";

    const safeName = path
      .basename(file.originalname, extension)
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 70);

    req.documentId = id;

    callback(
      null,
      `${id}-${safeName || "document"}${extension}`
    );
  },
});

const pdfFileFilter = (req, file, callback) => {
  const hasPdfMimeType =
    file.mimetype === "application/pdf";

  const hasPdfExtension =
    file.originalname.toLowerCase().endsWith(".pdf");

  if (!hasPdfMimeType && !hasPdfExtension) {
    callback(new Error("Only PDF files are allowed."));
    return;
  }

  callback(null, true);
};

export const uploadPdf = multer({
  storage,
  fileFilter: pdfFileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 1,
  },
}); 