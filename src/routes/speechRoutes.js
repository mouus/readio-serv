import {
  Router,
} from "express";

import {
  generateQuestion,
  generateSpeech,
  getSpeechOptions,
} from "../controllers/speechController.js";

const router = Router();

router.get(
  "/options",
  getSpeechOptions
);

router.post(
  "/generate",
  generateSpeech
);

router.post(
  "/question",
  generateQuestion
);

export default router;