<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
        ${kcSanitize(msg("errorTitle"))?no_esc}
    <#elseif section = "form">
        <div id="kc-error-message">
            <p class="instruction">${kcSanitize(message.summary)?no_esc}</p>
            <#if traceId??>
                <p class="instruction" id="traceId">${msg("traceIdSupportMessage", traceId)}</p>
            </#if>
            <#if skipLink??>
            <#else>
                <#-- Without a client, link the proxy's /auth/return: proxy-context.js adds the client_id
                     remembered from the login page, and the proxy redirects only to that client's home. -->
                <#assign appHome = properties.backToApplicationUrl!"">
                <#if client?? && client.baseUrl?has_content>
                    <p><a id="backToApplication" href="${client.baseUrl}">${msg("backToApplication")}</a></p>
                <#elseif appHome?starts_with("http")>
                    <p><a id="backToApplication" href="${appHome?remove_ending("/")}/auth/return">${msg("backToApplication")}</a></p>
                </#if>
            </#if>
        </div>
    </#if>
</@layout.registrationLayout>
