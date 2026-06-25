import { useSearchParams } from "react-router-dom";
import { ProjectSelector } from "../../components/ProjectSelector";
import { CardListSkeleton } from "../../components/Skeleton";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useProject, useProjects } from "../../hooks/useProjects";
import { useI18n } from "../../i18n";
import { GitStatusContent } from "../GitStatusPage";

export function SourceControlSettings() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const { projects, loading: projectsLoading } = useProjects();
  const effectiveProjectId = projectId || projects[0]?.id;
  const { project } = useProject(effectiveProjectId);
  const { gitStatus, loading, error } = useGitStatus(effectiveProjectId);

  useDocumentTitle(project?.name, t("gitStatusTitle"));

  const handleProjectChange = (newProjectId: string) => {
    setSearchParams({ projectId: newProjectId }, { replace: true });
  };

  return (
    <section className="settings-section">
      <div className="settings-source-control-header">
        <div>
          <h2>{t("gitStatusTitle")}</h2>
          <p className="settings-section-description">
            {t("settingsSourceControlDescription")}
          </p>
        </div>
        {effectiveProjectId ? (
          <ProjectSelector
            currentProjectId={effectiveProjectId}
            currentProjectName={project?.name}
            onProjectChange={(p) => handleProjectChange(p.id)}
          />
        ) : null}
      </div>

      {!effectiveProjectId && !projectsLoading && projects.length === 0 ? (
        <div className="error">{t("gitStatusNoProjects")}</div>
      ) : loading || projectsLoading ? (
        <CardListSkeleton count={4} height={56} />
      ) : error ? (
        <div className="error">
          {t("gitStatusErrorPrefix")} {error.message}
        </div>
      ) : gitStatus && !gitStatus.isGitRepo ? (
        <div className="git-status-empty content-fade-in">
          {t("gitStatusNotRepo")}
        </div>
      ) : gitStatus && effectiveProjectId ? (
        <div className="content-fade-in">
          <GitStatusContent
            status={gitStatus}
            projectId={effectiveProjectId}
            t={t as never}
          />
        </div>
      ) : null}
    </section>
  );
}
