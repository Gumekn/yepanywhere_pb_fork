import { SLASH_COMMAND_SESSION_KIND } from "@yep-anywhere/shared";
import { Link } from "react-router-dom";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { useI18n } from "../../i18n";

export function LibrarySettings() {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();

  return (
    <section className="settings-section">
      <h2>{t("settingsLibraryTitle")}</h2>
      <p className="settings-section-description">
        {t("settingsLibraryDescription")}
      </p>
      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("sidebarArchive")}</strong>
            <p>{t("libraryArchiveDescription")}</p>
          </div>
          <Link className="settings-button" to={`${basePath}/archive`}>
            {t("libraryOpen")}
          </Link>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("sidebarSlashCommands")}</strong>
            <p>{t("librarySlashCommandsDescription")}</p>
          </div>
          <Link
            className="settings-button"
            to={`${basePath}/sessions?kind=${SLASH_COMMAND_SESSION_KIND}`}
          >
            {t("libraryOpen")}
          </Link>
        </div>
      </div>
    </section>
  );
}
