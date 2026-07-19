import {
  Router,
} from "express";

import {
  deleteDocument,
  getDocument,
  getDocumentText,
  getServerHealth,
  listDocuments,
  uploadDocument,
} from "../controllers/documentController.js";

import {
  uploadPdf,
} from "../middleware/upload.js";

const router =
  Router();

router.get(
  "/health",
  getServerHealth
);

router.get(
  "/",
  listDocuments
);

router.post(
  "/upload",
  uploadPdf.single(
    "pdf"
  ),
  uploadDocument
);

router.get(
  "/:id/text",
  getDocumentText
);

router.get(
  "/:id",
  getDocument
);

router.delete(
  "/:id",
  deleteDocument
);

export default router;