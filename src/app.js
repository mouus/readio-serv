import cors from "cors";
import express from "express";
import path from "node:path";

import {
  initializeDatabase,
} from "./database.js";

import userRoutes from "./routes/userRoutes.js";
import documentRoutes from "./routes/documentRoutes.js";
import speechRoutes from "./routes/speechRoutes.js";

const app = express();

app.disable("x-powered-by");

app.use(
  cors({
    origin: "*",

    methods: [
      "GET",
      "POST",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],
  }),
);

app.use(
  express.json({
    limit: "1mb",
  }),
);

/*
 * Initialize Neon without blocking
 * the HTTP server startup.
 */
initializeDatabase().catch(
  (error) => {
    console.error(
      "Failed to initialize Neon:",
      error,
    );
  },
);

/*
 * PDF files.
 */
app.use(
  "/uploads",
  express.static(
    path.resolve("uploads"),
    {
      fallthrough: false,

      setHeaders: (res) => {
        res.setHeader(
          "Content-Type",
          "application/pdf",
        );

        res.setHeader(
          "Content-Disposition",
          "inline",
        );

        res.setHeader(
          "Cache-Control",
          "private, max-age=3600",
        );
      },
    },
  ),
);

/*
 * Generated audio files.
 */
app.use(
  "/generated-audio",
  express.static(
    path.resolve(
      "generated-audio",
    ),
    {
      fallthrough: false,

      setHeaders: (res) => {
        res.setHeader(
          "Content-Type",
          "audio/mpeg",
        );

        res.setHeader(
          "Accept-Ranges",
          "bytes",
        );

        res.setHeader(
          "Cache-Control",
          "private, max-age=86400",
        );
      },
    },
  ),
);

/*
 * Health check.
 */
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    name: "Readio API",
    version: "1.0.0",
  });
});

/*
 * API routes.
 */
app.use(
  "/api/users",
  userRoutes,
);

app.use(
  "/api/documents",
  documentRoutes,
);

app.use(
  "/api/speech",
  speechRoutes,
);

/*
 * Unknown route.
 */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message:
      "Route not found.",
  });
});

/*
 * Error handler.
 */
app.use(
  (
    error,
    req,
    res,
    next,
  ) => {
    console.error(
      "Server error:",
      error,
    );

    if (
      error.code ===
      "LIMIT_FILE_SIZE"
    ) {
      return res.status(413).json({
        success: false,
        message:
          "The PDF must be smaller than 20 MB.",
      });
    }

    if (
      error.code ===
      "LIMIT_UNEXPECTED_FILE"
    ) {
      return res.status(400).json({
        success: false,
        message:
          'The upload field must be named "pdf".',
      });
    }

    if (
      error.message ===
      "Only PDF files are allowed."
    ) {
      return res.status(400).json({
        success: false,
        message:
          error.message,
      });
    }

    return res.status(500).json({
      success: false,

      message:
        error instanceof Error
          ? error.message
          : "Something went wrong on the server.",
    });
  },
);

export default app;