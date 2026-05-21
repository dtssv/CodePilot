import { changePluginLocale } from '../../state/localeBridge';
import { useTranslation, type Locale } from '../../i18n';

export function LanguageSelector() {
    const { t, locale } = useTranslation();

    return (
        <label className="language-selector" title={t('language.label')}>
            <span className="language-selector-icon" aria-hidden>
                🌐
            </span>
            <select
                className="language-selector-select"
                value={locale}
                onChange={(e) => changePluginLocale(e.target.value as Locale)}
                aria-label={t('language.label')}
            >
                <option value="en">{t('language.en')}</option>
                <option value="zh">{t('language.zh')}</option>
            </select>
        </label>
    );
}
