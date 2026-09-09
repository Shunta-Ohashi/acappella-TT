import type {
  SectionSettingsDraft,
  SectionSettingsValidationErrors,
} from '../domain/eventStageSettings'

interface StageSectionSettingsProps {
  stageName: string
  sections: SectionSettingsDraft[]
  errors: Record<string, SectionSettingsValidationErrors>
  onAdd: () => void
  onUpdate: (
    draftId: string,
    update: (section: SectionSettingsDraft) => SectionSettingsDraft,
  ) => void
  onRemove: (section: SectionSettingsDraft) => void
}

export function StageSectionSettings({
  stageName,
  sections,
  errors,
  onAdd,
  onUpdate,
  onRemove,
}: StageSectionSettingsProps) {
  const accessibleStageName = stageName.trim() || '新しいStage'

  return (
    <section
      className="stage-section-settings"
      aria-label={`${accessibleStageName}のSection設定`}
    >
      <header className="stage-section-settings__header">
        <div>
          <h5>Section</h5>
          <p>部などの区切りが必要な場合に設定します。</p>
        </div>
        <button type="button" className="secondary-button" onClick={onAdd}>
          <span aria-hidden="true">＋</span> Sectionを追加
        </button>
      </header>

      {sections.length === 0 ? (
        <p className="stage-section-settings__empty">
          このStageではSectionを使用していません。
        </p>
      ) : (
        <div className="section-settings-list">
          {sections.map((section, index) => {
            const sectionErrors = errors[section.draftId] ?? {}
            const idPrefix = `section-settings-${section.draftId}`
            const sectionName = section.name.trim() || '新しいSection'

            return (
              <article key={section.draftId} className="section-settings-card">
                <header className="section-settings-card__header">
                  <div>
                    <p>Section {index + 1}</p>
                    <h6>{sectionName}</h6>
                  </div>
                  <button
                    type="button"
                    className="section-settings-card__delete"
                    aria-label={`${sectionName}を削除`}
                    onClick={() => onRemove(section)}
                  >
                    削除
                  </button>
                </header>

                <div className="section-settings-field">
                  <label htmlFor={`${idPrefix}-name`}>
                    Section名 <span aria-hidden="true">*</span>
                  </label>
                  <input
                    id={`${idPrefix}-name`}
                    type="text"
                    required
                    placeholder="1部"
                    value={section.name}
                    aria-invalid={sectionErrors.name ? 'true' : undefined}
                    aria-describedby={sectionErrors.name
                      ? `${idPrefix}-name-error`
                      : undefined}
                    onChange={(event) => onUpdate(
                      section.draftId,
                      (current) => ({ ...current, name: event.target.value }),
                    )}
                  />
                  {sectionErrors.name && (
                    <p
                      id={`${idPrefix}-name-error`}
                      className="form-error"
                      role="alert"
                    >
                      {sectionErrors.name}
                    </p>
                  )}
                </div>

                <div className="section-settings-card__time-grid">
                  <fieldset className="section-settings-time">
                    <legend>開始</legend>
                    <label>
                      <input
                        type="radio"
                        name={`${idPrefix}-start-mode`}
                        checked={section.startMode === 'automatic'}
                        onChange={() => onUpdate(
                          section.draftId,
                          (current) => ({
                            ...current,
                            startMode: 'automatic',
                          }),
                        )}
                      />
                      {index === 0
                        ? '自動（Stage開始から）'
                        : '自動（前のSectionから継続）'}
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`${idPrefix}-start-mode`}
                        checked={section.startMode === 'fixed'}
                        onChange={() => onUpdate(
                          section.draftId,
                          (current) => ({ ...current, startMode: 'fixed' }),
                        )}
                      />
                      固定
                    </label>
                    {section.startMode === 'fixed' && (
                      <div className="section-settings-time__value">
                        <label
                          className="visually-hidden"
                          htmlFor={`${idPrefix}-start-time`}
                        >
                          Section固定開始時刻
                        </label>
                        <input
                          id={`${idPrefix}-start-time`}
                          type="time"
                          required
                          value={section.plannedStartTime}
                          aria-invalid={sectionErrors.plannedStartTime
                            ? 'true'
                            : undefined}
                          aria-describedby={sectionErrors.plannedStartTime
                            ? `${idPrefix}-start-time-error`
                            : undefined}
                          onChange={(event) => onUpdate(
                            section.draftId,
                            (current) => ({
                              ...current,
                              plannedStartTime: event.target.value,
                            }),
                          )}
                        />
                        {sectionErrors.plannedStartTime && (
                          <p
                            id={`${idPrefix}-start-time-error`}
                            className="form-error"
                            role="alert"
                          >
                            {sectionErrors.plannedStartTime}
                          </p>
                        )}
                      </div>
                    )}
                  </fieldset>

                  <fieldset className="section-settings-time">
                    <legend>終了</legend>
                    <label>
                      <input
                        type="radio"
                        name={`${idPrefix}-end-mode`}
                        checked={section.endMode === 'automatic'}
                        onChange={() => onUpdate(
                          section.draftId,
                          (current) => ({ ...current, endMode: 'automatic' }),
                        )}
                      />
                      自動（タイムテーブルから算出）
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`${idPrefix}-end-mode`}
                        checked={section.endMode === 'fixed'}
                        onChange={() => onUpdate(
                          section.draftId,
                          (current) => ({ ...current, endMode: 'fixed' }),
                        )}
                      />
                      固定
                    </label>
                    {section.endMode === 'fixed' && (
                      <div className="section-settings-time__value">
                        <label
                          className="visually-hidden"
                          htmlFor={`${idPrefix}-end-time`}
                        >
                          Section固定終了時刻
                        </label>
                        <input
                          id={`${idPrefix}-end-time`}
                          type="time"
                          required
                          value={section.plannedEndTime}
                          aria-invalid={sectionErrors.plannedEndTime
                            ? 'true'
                            : undefined}
                          aria-describedby={sectionErrors.plannedEndTime
                            ? `${idPrefix}-end-time-error`
                            : undefined}
                          onChange={(event) => onUpdate(
                            section.draftId,
                            (current) => ({
                              ...current,
                              plannedEndTime: event.target.value,
                            }),
                          )}
                        />
                        {sectionErrors.plannedEndTime && (
                          <p
                            id={`${idPrefix}-end-time-error`}
                            className="form-error"
                            role="alert"
                          >
                            {sectionErrors.plannedEndTime}
                          </p>
                        )}
                      </div>
                    )}
                  </fieldset>
                </div>

                {sectionErrors.form && (
                  <p className="form-error section-settings-card__error" role="alert">
                    {sectionErrors.form}
                  </p>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
