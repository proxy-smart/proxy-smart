<#import "social-providers.ftl" as identityProviders>
<#import "legal-links.ftl" as legal>

<#-- Identity providers lead the card; the nested form sits in a closed <details> under them, or bare when there is no provider. -->
<#macro card social expand>
    <#if realm.password && social.providers?? && social.providers?has_content>
        <div class="ps-login-social-top">
            <@identityProviders.show social=social showLabel=false/>
        </div>
        <details class="ps-password-disclosure"<#if expand> open</#if>>
            <summary class="ps-password-summary">${msg("passwordSignInToggle")}</summary>
            <#nested expand>
        </details>
    <#else>
        <#nested true>
    </#if>
    <@legal.links />
</#macro>
