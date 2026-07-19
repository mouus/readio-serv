import {
  neon,
} from "@neondatabase/serverless";

import crypto from "node:crypto";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import {
  getSignedUrl,
} from "@aws-sdk/s3-request-presigner";

import OpenAI from "openai";

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

if (
  !process.env.OPENAI_API_KEY
) {
  throw new Error(
    "OPENAI_API_KEY is missing from the backend environment variables."
  );
}

const sql =
  neon(
    process.env.DATABASE_URL
  );

const openai =
  new OpenAI({
    apiKey:
      process.env
        .OPENAI_API_KEY,
  });

const MAX_SPEECH_LENGTH =
  4096;

const QUESTION_CONTEXT_LENGTH =
  10000;

const SIGNED_URL_EXPIRATION =
  60 * 60;

const AVAILABLE_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
];

const AVAILABLE_STYLES = [
  "calm",
  "friendly",
  "professional",
  "storytelling",
  "energetic",
  "gentle",
];

const STYLE_INSTRUCTIONS = {
  calm:
    "Speak calmly and clearly with a relaxed, steady pace.",

  friendly:
    "Speak warmly and naturally, like a helpful friend.",

  professional:
    "Speak clearly and professionally with confident pacing.",

  storytelling:
    "Read expressively like a thoughtful storyteller while remaining easy to understand.",

  energetic:
    "Speak with lively, positive energy while remaining clear.",

  gentle:
    "Speak softly and gently with a comforting tone.",
};

const cleanText = (
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
      /\s+/g,
      " "
    )
    .trim();
};

const clampNumber = (
  value,
  minimum,
  maximum,
  fallback
) => {
  const parsed =
    Number(value);

  if (
    !Number.isFinite(
      parsed
    )
  ) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.max(
      minimum,
      parsed
    )
  );
};

const getSpeechFilename = ({
  text,
  voice,
  style,
  speed,
}) => {
  const hash =
    crypto
      .createHash(
        "sha256"
      )
      .update(
        JSON.stringify({
          text,
          voice,
          style,
          speed,
        })
      )
      .digest(
        "hex"
      )
      .slice(
        0,
        32
      );

  return `${hash}.mp3`;
};

const getSpeechS3Key = (
  filename
) => {
  return `speech/${filename}`;
};

const s3ObjectExists =
  async (
    key
  ) => {
    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket:
            s3BucketName,

          Key:
            key,
        })
      );

      return true;
    } catch (error) {
      const statusCode =
        error?.$metadata
          ?.httpStatusCode;

      if (
        statusCode === 404 ||
        error?.name ===
          "NotFound" ||
        error?.name ===
          "NoSuchKey"
      ) {
        return false;
      }

      throw error;
    }
  };

const createSignedAudioUrl =
  async (
    key,
    filename
  ) => {
    const command =
      new GetObjectCommand({
        Bucket:
          s3BucketName,

        Key:
          key,

        ResponseContentType:
          "audio/mpeg",

        ResponseContentDisposition:
          `inline; filename="${filename}"`,
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

const getQuestionExcerpt = (
  text
) => {
  if (
    text.length <=
    QUESTION_CONTEXT_LENGTH
  ) {
    return text;
  }

  const maximumStart =
    text.length -
    QUESTION_CONTEXT_LENGTH;

  const randomStart =
    Math.floor(
      Math.random() *
        (
          maximumStart +
          1
        )
    );

  const nextSpace =
    text.indexOf(
      " ",
      randomStart
    );

  const start =
    nextSpace >= 0 &&
    nextSpace -
      randomStart <
      100
      ? nextSpace + 1
      : randomStart;

  return text
    .slice(
      start,
      start +
        QUESTION_CONTEXT_LENGTH
    )
    .trim();
};

const formatGeneratedQuestion = (
  value
) => {
  let question =
    cleanText(
      value
    )
      .replace(
        /^(?:question|q)\s*:\s*/i,
        ""
      )
      .replace(
        /^\d+[.)]\s*/,
        ""
      )
      .replace(
        /^["'`]+|["'`]+$/g,
        ""
      )
      .trim();

  const questionMarkIndex =
    question.indexOf(
      "?"
    );

  if (
    questionMarkIndex >=
    0
  ) {
    question =
      question.slice(
        0,
        questionMarkIndex +
          1
      );
  } else if (
    question
  ) {
    question += "?";
  }

  return question;
};

/*
 * GET /api/speech/options
 */
export const getSpeechOptions =
  async (
    req,
    res,
    next
  ) => {
    try {
      return res
        .status(200)
        .json({
          success:
            true,

          options: {
            voices:
              AVAILABLE_VOICES,

            styles:
              AVAILABLE_STYLES,

            speeds: [
              0.75,
              1,
              1.25,
              1.5,
            ],

            defaultVoice:
              "coral",

            defaultStyle:
              "calm",

            defaultSpeed:
              1,
          },
        });
    } catch (error) {
      console.error(
        "Get speech options error:",
        error
      );

      next(error);
    }
  };

/*
 * POST /api/speech/generate
 *
 * Body:
 * {
 *   text: string,
 *   voice?: string,
 *   style?: string,
 *   speed?: number
 * }
 */
export const generateSpeech =
  async (
    req,
    res,
    next
  ) => {
    try {
      const text =
        cleanText(
          req.body?.text
        );

      const requestedVoice =
        cleanText(
          req.body?.voice
        ).toLowerCase();

      const requestedStyle =
        cleanText(
          req.body?.style
        ).toLowerCase();

      const voice =
        AVAILABLE_VOICES.includes(
          requestedVoice
        )
          ? requestedVoice
          : "coral";

      const style =
        AVAILABLE_STYLES.includes(
          requestedStyle
        )
          ? requestedStyle
          : "calm";

      const speed =
        clampNumber(
          req.body?.speed,
          0.25,
          4,
          1
        );

      if (!text) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Speech text is required.",
          });
      }

      if (
        text.length >
        MAX_SPEECH_LENGTH
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              `Speech text must be ${MAX_SPEECH_LENGTH} characters or fewer.`,
          });
      }

      const filename =
        getSpeechFilename({
          text,
          voice,
          style,
          speed,
        });

      const s3Key =
        getSpeechS3Key(
          filename
        );

      const cached =
        await s3ObjectExists(
          s3Key
        );

      if (!cached) {
        const speech =
          await openai
            .audio
            .speech
            .create({
              model:
                process.env
                  .OPENAI_SPEECH_MODEL ||
                "gpt-4o-mini-tts",

              voice,

              input:
                text,

              instructions:
                STYLE_INSTRUCTIONS[
                  style
                ],

              response_format:
                "mp3",

              speed,
            });

        const audioBuffer =
          Buffer.from(
            await speech.arrayBuffer()
          );

        await s3Client.send(
          new PutObjectCommand({
            Bucket:
              s3BucketName,

            Key:
              s3Key,

            Body:
              audioBuffer,

            ContentType:
              "audio/mpeg",

            ContentLength:
              audioBuffer.length,

            ContentDisposition:
              `inline; filename="${filename}"`,

            CacheControl:
              "private, max-age=31536000",

            Metadata: {
              voice,
              style,

              speed:
                String(
                  speed
                ),
            },
          })
        );

        console.log(
          "Speech uploaded to S3:",
          {
            bucket:
              s3BucketName,

            key:
              s3Key,

            size:
              audioBuffer.length,
          }
        );
      }

      const url =
        await createSignedAudioUrl(
          s3Key,
          filename
        );

      return res
        .status(200)
        .json({
          success:
            true,

          audio: {
            voice,
            style,
            speed,
            filename,

            s3Key,

            cached,

            url,

            expiresIn:
              SIGNED_URL_EXPIRATION,

            aiGenerated:
              true,
          },
        });
    } catch (error) {
      console.error(
        "Generate speech error:",
        error
      );

      next(error);
    }
  };

/*
 * POST /api/speech/question
 *
 * Body:
 * {
 *   documentId: string,
 *   previousQuestion?: string
 * }
 */
export const generateQuestion =
  async (
    req,
    res,
    next
  ) => {
    try {
      const documentId =
        cleanText(
          req.body
            ?.documentId
        );

      const previousQuestion =
        cleanText(
          req.body
            ?.previousQuestion
        ).slice(
          0,
          500
        );

      if (!documentId) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "documentId is required.",
          });
      }

      const rows =
        await sql`
          SELECT
            id,
            name,
            extracted_text,
            has_text
          FROM documents
          WHERE id =
            ${documentId}
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

      const documentText =
        cleanText(
          document
            .extracted_text
        );

      if (
        !document.has_text ||
        !documentText
      ) {
        return res
          .status(422)
          .json({
            success:
              false,

            message:
              "This PDF does not contain readable text.",
          });
      }

      const excerpt =
        getQuestionExcerpt(
          documentText
        );

      const instructions = [
        "Write exactly one comprehension question about the PDF excerpt.",
        "The answer must be present in the excerpt.",
        "Return only the question.",
        "Do not return an answer.",
        "Do not include a label, explanation, hint, or numbering.",
        "Use fewer than 24 words.",
        "End with a question mark.",

        previousQuestion
          ? `Do not repeat this previous question: ${previousQuestion}`
          : "",
      ]
        .filter(
          Boolean
        )
        .join(
          " "
        );

      const response =
        await openai
          .responses
          .create({
            model:
              process.env
                .OPENAI_QUESTION_MODEL ||
              "gpt-5-mini",

            store:
              false,

            max_output_tokens:
              300,

            reasoning: {
              effort:
                "minimal",
            },

            input: [
              {
                role:
                  "developer",

                content: [
                  {
                    type:
                      "input_text",

                    text:
                      instructions,
                  },
                ],
              },

              {
                role:
                  "user",

                content: [
                  {
                    type:
                      "input_text",

                    text: [
                      `PDF title: ${
                        document.name ||
                        "Untitled PDF"
                      }`,

                      "PDF excerpt:",

                      excerpt,
                    ].join(
                      "\n\n"
                    ),
                  },
                ],
              },
            ],
          });

      console.log(
        "Question response status:",
        response.status
      );

      console.log(
        "Question incomplete details:",
        response
          .incomplete_details ||
          null
      );

      console.log(
        "Question output text:",
        response.output_text
      );

      let rawQuestion =
        typeof response
          .output_text ===
        "string"
          ? response
              .output_text
          : "";

      if (
        !rawQuestion.trim()
      ) {
        rawQuestion =
          response.output
            ?.flatMap(
              (
                item
              ) =>
                item.type ===
                "message"
                  ? item.content ||
                    []
                  : []
            )
            .filter(
              (
                content
              ) =>
                content.type ===
                "output_text"
            )
            .map(
              (
                content
              ) =>
                content.text ||
                ""
            )
            .join(
              " "
            )
            .trim() ||
          "";
      }

      const question =
        formatGeneratedQuestion(
          rawQuestion
        );

      if (!question) {
        console.error(
          "Empty question response:",
          JSON.stringify(
            response,
            null,
            2
          )
        );

        return res
          .status(502)
          .json({
            success:
              false,

            message:
              response.status ===
              "incomplete"
                ? "The AI response was incomplete. Please try again."
                : "The AI did not generate a question. Please try again.",
          });
      }

      return res
        .status(200)
        .json({
          success:
            true,

          question,
        });
    } catch (error) {
      console.error(
        "Generate question error:",
        error
      );

      next(error);
    }
  };