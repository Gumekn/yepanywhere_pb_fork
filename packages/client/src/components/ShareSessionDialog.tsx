import {
  DEFAULT_SESSION_SHARE_EXPIRY,
  SESSION_SHARE_EXPIRY_OPTIONS,
  type SessionShareExpiry,
  type SessionShareRecord,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";
import { buildShareMarkdownUrl, buildShareUrl } from "../lib/sessionShareLinks";
import { Modal } from "./ui/Modal";
import "../styles/session-share.css";

interface ShareSessionDialogProps {
  projectId: string;
  sessionId: string;
  /** Title as shown to the owner; frozen into the snapshot. */
  title?: string | null;
  onClose: () => void;
}

const EXPIRY_LABEL_KEYS = {
  "1d": "sessionShareExpiry1d",
  "7d": "sessionShareExpiry7d",
  "30d": "sessionShareExpiry30d",
  never: "sessionShareExpiryNever",
} as const satisfies Record<SessionShareExpiry, string>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create and manage read-only share links for one session.
 *
 * A link is a snapshot frozen at creation time, so creating another one is
 * how the owner shares newer turns; old links keep showing what they showed.
 */
export function ShareSessionDialog({
  projectId,
  sessionId,
  title,
  onClose,
}: ShareSessionDialogProps) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [expiresIn, setExpiresIn] = useState<SessionShareExpiry>(
    DEFAULT_SESSION_SHARE_EXPIRY,
  );
  const [creating, setCreating] = useState(false);
  const [shares, setShares] = useState<SessionShareRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [latestToken, setLatestToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const formatTime = useCallback(
    (iso: string) => new Date(iso).toLocaleString(),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .listSessionShareLinks(projectId, sessionId)
      .then((result) => {
        if (!cancelled) setShares(result.shares);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId]);

  const copy = useCallback(
    async (text: string) => {
      try {
        await writeClipboardText(text);
        showToast(t("sessionLinkCopied"), "success");
      } catch {
        showToast(t("sessionMenuInfoCopyFailed"), "error");
      }
    },
    [showToast, t],
  );

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { share } = await api.createSessionShareLink({
        projectId,
        sessionId,
        expiresIn,
        title,
      });
      setShares((current) => [share, ...(current ?? [])]);
      setLatestToken(share.token);
      try {
        await writeClipboardText(buildShareUrl(share.token));
        showToast(t("sessionShareCreated"), "success");
      } catch {
        // Clipboard access can be refused (no user gesture left after the
        // await); the link is still shown with its own copy button.
      }
    } catch (error) {
      showToast(
        t("sessionShareCreateFailed", { message: errorMessage(error) }),
        "error",
      );
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (token: string) => {
    if (revoking) return;
    setRevoking(token);
    try {
      await api.revokeSessionShareLink(token);
      setShares((current) =>
        (current ?? []).filter((share) => share.token !== token),
      );
      if (latestToken === token) setLatestToken(null);
      showToast(t("sessionShareRevoked"), "success");
    } catch (error) {
      showToast(
        t("sessionShareRevokeFailed", { message: errorMessage(error) }),
        "error",
      );
    } finally {
      setRevoking(null);
    }
  };

  return (
    <Modal title={t("sessionShareDialogTitle")} onClose={onClose}>
      <div className="share-dialog">
        <p className="share-dialog__description">
          {t("sessionShareDialogDescription")}
        </p>

        <fieldset className="share-dialog__expiry">
          <legend className="share-dialog__label">
            {t("sessionShareExpiryLabel")}
          </legend>
          <div className="share-dialog__expiry-options">
            {SESSION_SHARE_EXPIRY_OPTIONS.map((option) => (
              <label
                key={option}
                className={`share-dialog__expiry-option${
                  option === expiresIn ? " is-selected" : ""
                }`}
              >
                <input
                  type="radio"
                  name="share-expiry"
                  value={option}
                  checked={option === expiresIn}
                  onChange={() => setExpiresIn(option)}
                  disabled={creating}
                />
                {t(EXPIRY_LABEL_KEYS[option])}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="share-dialog__actions">
          <button
            type="button"
            className="share-dialog__button primary"
            onClick={() => void handleCreate()}
            disabled={creating}
          >
            {creating ? t("sessionShareCreating") : t("sessionShareCreate")}
          </button>
        </div>

        {latestToken && (
          <div className="share-dialog__result">
            <input
              className="share-dialog__url"
              type="text"
              readOnly
              value={buildShareUrl(latestToken)}
              onFocus={(event) => event.currentTarget.select()}
              aria-label={t("sessionShareCopyLink")}
            />
            <div className="share-dialog__actions">
              <button
                type="button"
                className="share-dialog__button"
                onClick={() => void copy(buildShareUrl(latestToken))}
              >
                {t("sessionShareCopyLink")}
              </button>
              <button
                type="button"
                className="share-dialog__button"
                onClick={() => void copy(buildShareMarkdownUrl(latestToken))}
              >
                {t("sessionShareCopyMarkdown")}
              </button>
            </div>
            <p className="share-dialog__hint">
              {t("sessionShareMarkdownHint")}
            </p>
          </div>
        )}

        <section className="share-dialog__existing">
          <h3 className="share-dialog__label">
            {t("sessionShareExistingTitle")}
          </h3>
          {loadFailed ? (
            <p className="share-dialog__hint">{t("sessionShareLoadFailed")}</p>
          ) : shares === null ? null : shares.length === 0 ? (
            <p className="share-dialog__hint">{t("sessionShareNoLinks")}</p>
          ) : (
            <ul className="share-dialog__list">
              {shares.map((share) => (
                <li key={share.token} className="share-dialog__item">
                  <div className="share-dialog__item-meta">
                    <span>
                      {t("sessionShareCreatedAt", {
                        time: formatTime(share.createdAt),
                      })}
                    </span>
                    <span className="share-dialog__item-expiry">
                      {share.expiresAt
                        ? t("sessionShareExpiresAt", {
                            time: formatTime(share.expiresAt),
                          })
                        : t("sessionShareNeverExpires")}
                    </span>
                  </div>
                  <div className="share-dialog__item-actions">
                    <button
                      type="button"
                      className="share-dialog__button"
                      onClick={() => void copy(buildShareUrl(share.token))}
                    >
                      {t("sessionShareCopyLink")}
                    </button>
                    <button
                      type="button"
                      className="share-dialog__button danger"
                      onClick={() => void handleRevoke(share.token)}
                      disabled={revoking !== null}
                    >
                      {t("sessionShareRevoke")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
