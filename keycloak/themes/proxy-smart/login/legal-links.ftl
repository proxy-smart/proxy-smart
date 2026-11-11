<#macro links>
    <#assign privacyUrl = properties.legalPrivacyUrl!"">
    <#assign termsUrl = properties.legalTermsUrl!"">
    <#if privacyUrl?starts_with("https://") || termsUrl?starts_with("https://")>
        <p class="ps-legal-links">
            <#if privacyUrl?starts_with("https://")><a href="${privacyUrl}" target="_blank" rel="noopener">${msg("legalPrivacy")}</a></#if>
            <#if termsUrl?starts_with("https://")><a href="${termsUrl}" target="_blank" rel="noopener">${msg("legalTerms")}</a></#if>
        </p>
    </#if>
</#macro>
