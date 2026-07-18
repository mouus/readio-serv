import express from "express";

import {
  sql,
} from "../database.js";

const router =
  express.Router();

const ALLOWED_VOICES = [
  "nova",
  "alloy",
  "shimmer",
];

const ALLOWED_READING_STYLES = [
  "natural",
  "focused",
  "gentle",
];

const ALLOWED_READING_SPEEDS = [
  "0.9",
  "1.0",
  "1.15",
];

function nullableString(
  value,
) {
  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const normalized =
    value.trim();

  return normalized.length > 0
    ? normalized
    : null;
}

function normalizeEmail(
  value,
) {
  const email =
    nullableString(value);

  return email
    ? email.toLowerCase()
    : null;
}

function stringArray(
  value,
) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item) =>
        typeof item ===
          "string" &&
        item.trim().length >
          0,
    )
    .map(
      (item) =>
        item.trim(),
    );
}

/*
 * POST /api/users/sync
 *
 * Creates or updates the Clerk user.
 *
 * The Clerk ID is stored in:
 * clerk_uuid
 *
 * Email is stored in the same user row.
 */
router.post(
  "/sync",
  async (
    req,
    res,
    next,
  ) => {
    try {
      const {
        clerkId,
        clerkUuid,
        name,
        firstName,
        lastName,
        email,
        username,
        imageUrl,
        phoneNumber,
      } = req.body ?? {};

      /*
       * Supports both names from the frontend:
       *
       * clerkId
       * clerkUuid
       */
      const resolvedClerkUuid =
        nullableString(
          clerkUuid,
        ) ??
        nullableString(
          clerkId,
        );

      if (!resolvedClerkUuid) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "A valid Clerk user UUID is required.",
          });
      }

      const normalizedEmail =
        normalizeEmail(email);

      const rows = await sql`
        INSERT INTO users (
          clerk_uuid,
          name,
          first_name,
          last_name,
          email,
          username,
          image_url,
          phone_number
        )
        VALUES (
          ${resolvedClerkUuid},
          ${nullableString(name)},
          ${nullableString(firstName)},
          ${nullableString(lastName)},
          ${normalizedEmail},
          ${nullableString(username)},
          ${nullableString(imageUrl)},
          ${nullableString(phoneNumber)}
        )

        ON CONFLICT (clerk_uuid)
        DO UPDATE SET
          name =
            EXCLUDED.name,

          first_name =
            EXCLUDED.first_name,

          last_name =
            EXCLUDED.last_name,

          email =
            EXCLUDED.email,

          username =
            EXCLUDED.username,

          image_url =
            EXCLUDED.image_url,

          phone_number =
            EXCLUDED.phone_number,

          updated_at =
            NOW()

        RETURNING
          id,
          clerk_uuid,
          name,
          first_name,
          last_name,
          email,
          username,
          image_url,
          phone_number,
          onboarding_completed,
          is_premium,
          subscription_status,
          entitlement_ids,
          active_subscriptions,
          product_identifier,
          subscription_expires_at,
          reading_voice,
          reading_style,
          reading_speed,
          created_at,
          updated_at
      `;

      return res
        .status(200)
        .json({
          success: true,
          user: rows[0],
        });
    } catch (error) {
      next(error);
    }
  },
);

/*
 * GET /api/users/:clerkUuid
 *
 * Loads the complete user including reading preferences.
 */
router.get(
  "/:clerkUuid",
  async (
    req,
    res,
    next,
  ) => {
    try {
      const {
        clerkUuid,
      } = req.params;

      const rows = await sql`
        SELECT
          id,
          clerk_uuid,
          name,
          first_name,
          last_name,
          email,
          username,
          image_url,
          phone_number,
          onboarding_completed,
          is_premium,
          subscription_status,
          entitlement_ids,
          active_subscriptions,
          product_identifier,
          subscription_expires_at,
          reading_voice,
          reading_style,
          reading_speed,
          created_at,
          updated_at
        FROM users
        WHERE clerk_uuid =
          ${clerkUuid}
        LIMIT 1
      `;

      if (!rows[0]) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "User not found.",
          });
      }

      return res
        .status(200)
        .json({
          success: true,
          user: rows[0],
        });
    } catch (error) {
      next(error);
    }
  },
);

/*
 * PATCH /api/users/:clerkUuid/onboarding
 */
router.patch(
  "/:clerkUuid/onboarding",
  async (
    req,
    res,
    next,
  ) => {
    try {
      const {
        clerkUuid,
      } = req.params;

      const completed =
        req.body?.completed ===
        true;

      const rows = await sql`
        UPDATE users
        SET
          onboarding_completed =
            ${completed},

          updated_at =
            NOW()

        WHERE clerk_uuid =
          ${clerkUuid}

        RETURNING
          id,
          clerk_uuid,
          email,
          onboarding_completed,
          updated_at
      `;

      if (!rows[0]) {
        return res
          .status(404)
          .json({
            success: false,

            message:
              "User not found. Sync the user first.",
          });
      }

      return res
        .status(200)
        .json({
          success: true,
          user: rows[0],
        });
    } catch (error) {
      next(error);
    }
  },
);

/*
 * PATCH /api/users/:clerkUuid/preferences
 *
 * Body example:
 *
 * {
 *   "readingVoice": "nova",
 *   "readingStyle": "natural",
 *   "readingSpeed": "1.0"
 * }
 */
router.patch(
  "/:clerkUuid/preferences",
  async (
    req,
    res,
    next,
  ) => {
    try {
      const {
        clerkUuid,
      } = req.params;

      const {
        readingVoice,
        readingStyle,
        readingSpeed,
      } = req.body ?? {};

      if (
        typeof clerkUuid !==
          "string" ||
        clerkUuid.trim()
          .length === 0
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "A valid Clerk UUID is required.",
          });
      }

      if (
        readingVoice !==
          undefined &&
        !ALLOWED_VOICES.includes(
          readingVoice,
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "Invalid reading voice.",
          });
      }

      if (
        readingStyle !==
          undefined &&
        !ALLOWED_READING_STYLES.includes(
          readingStyle,
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "Invalid reading style.",
          });
      }

      if (
        readingSpeed !==
          undefined &&
        !ALLOWED_READING_SPEEDS.includes(
          readingSpeed,
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "Invalid reading speed.",
          });
      }

      const rows = await sql`
        UPDATE users
        SET
          reading_voice =
            COALESCE(
              ${readingVoice ?? null},
              reading_voice
            ),

          reading_style =
            COALESCE(
              ${readingStyle ?? null},
              reading_style
            ),

          reading_speed =
            COALESCE(
              ${readingSpeed ?? null},
              reading_speed
            ),

          updated_at =
            NOW()

        WHERE clerk_uuid =
          ${clerkUuid.trim()}

        RETURNING
          id,
          clerk_uuid,
          email,
          reading_voice,
          reading_style,
          reading_speed,
          updated_at
      `;

      if (!rows[0]) {
        return res
          .status(404)
          .json({
            success: false,

            message:
              "User not found. Sync the user first.",
          });
      }

      console.log(
        "Reading preferences saved:",
        {
          clerkUuid:
            rows[0]
              .clerk_uuid,

          email:
            rows[0].email,

          readingVoice:
            rows[0]
              .reading_voice,

          readingStyle:
            rows[0]
              .reading_style,

          readingSpeed:
            rows[0]
              .reading_speed,
        },
      );

      return res
        .status(200)
        .json({
          success: true,
          user: rows[0],
        });
    } catch (error) {
      next(error);
    }
  },
);

/*
 * PATCH /api/users/:clerkUuid/subscription
 */
router.patch(
  "/:clerkUuid/subscription",
  async (
    req,
    res,
    next,
  ) => {
    try {
      const {
        clerkUuid,
      } = req.params;

      const {
        isPremium,
        subscriptionStatus,
        entitlementIds,
        activeSubscriptions,
        productIdentifier,
        expirationDate,
      } = req.body ?? {};

      const premium =
        isPremium === true;

      const cleanEntitlements =
        stringArray(
          entitlementIds,
        );

      const cleanSubscriptions =
        stringArray(
          activeSubscriptions,
        );

      const status =
        premium
          ? "active"
          : subscriptionStatus ===
              "expired"
            ? "expired"
            : "free";

      const product =
        nullableString(
          productIdentifier,
        ) ??
        cleanSubscriptions[0] ??
        null;

      const expiration =
        nullableString(
          expirationDate,
        );

      const rows = await sql`
        UPDATE users
        SET
          is_premium =
            ${premium},

          subscription_status =
            ${status},

          entitlement_ids =
            ${cleanEntitlements},

          active_subscriptions =
            ${cleanSubscriptions},

          product_identifier =
            ${product},

          subscription_expires_at =
            ${expiration},

          updated_at =
            NOW()

        WHERE clerk_uuid =
          ${clerkUuid}

        RETURNING
          id,
          clerk_uuid,
          email,
          is_premium,
          subscription_status,
          entitlement_ids,
          active_subscriptions,
          product_identifier,
          subscription_expires_at,
          reading_voice,
          reading_style,
          reading_speed,
          updated_at
      `;

      if (!rows[0]) {
        return res
          .status(404)
          .json({
            success: false,

            message:
              "User not found. Sync the user first.",
          });
      }

      return res
        .status(200)
        .json({
          success: true,
          user: rows[0],
        });
    } catch (error) {
      next(error);
    }
  },
);

/*
 * DELETE /api/users/:clerkUuid
 */
router.delete(
  "/:clerkUuid",
  async (
    req,
    res,
    next,
  ) => {
    try {
      const {
        clerkUuid,
      } = req.params;

      const rows = await sql`
        DELETE FROM users
        WHERE clerk_uuid =
          ${clerkUuid}

        RETURNING
          id,
          clerk_uuid,
          email
      `;

      return res
        .status(200)
        .json({
          success: true,
          deleted:
            rows.length > 0,

          message:
            "Readio user data deleted.",
        });
    } catch (error) {
      next(error);
    }
  },
);

export default router;