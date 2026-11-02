<#-- keycloak.v2 26.8.1 login-username.ftl (Organization identity-first step) with the form inside providers-first.ftl; re-diff on a Keycloak upgrade. -->
<#import "template.ftl" as layout>
<#import "field.ftl" as field>
<#import "buttons.ftl" as buttons>
<#import "providers-first.ftl" as providersFirst>
<#import "passkeys.ftl" as passkeys>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username') displayInfo=(realm.password && realm.registrationAllowed && !registrationDisabled??); section>
<!-- template: login-username.ftl (proxy-smart) -->

    <#if section = "header">
        ${msg("loginAccountTitle")}
    <#elseif section = "form">
        <#assign expandCredentials = messagesPerField.existsError('username')
            || enableWebAuthnConditionalUI?has_content
            || (login.username)?has_content>

        <@providersFirst.card social=social expand=expandCredentials; autofocusUsername>
        <div id="kc-form">
            <div id="kc-form-wrapper">
                <#if realm.password>
                    <form id="kc-form-login" class="${properties.kcFormClass!}" onsubmit="login.disabled = true; return true;" action="${url.loginAction}"
                          method="post">
                        <#-- Unlike the base, no extra form-group wrappers: field.input is one already, and the empty one took a grid gap. -->
                        <#if !usernameHidden??>
                            <#assign label>
                                <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if>
                            </#assign>
                            <@field.input name="username" label=label value=login.username!'' autofocus=autofocusUsername autocomplete="${(enableWebAuthnConditionalUI?has_content)?then('username webauthn', 'username')}" />
                            <#if realm.rememberMe>
                                <@field.checkbox name="rememberMe" label=msg("rememberMe") value=login.rememberMe?? />
                            </#if>
                        </#if>

                        <@buttons.loginButton />
                    </form>
                </#if>
            </div>
        </div>
        </@providersFirst.card>
        <@passkeys.conditionalUIData />

    <#elseif section = "info" >
        <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
            <div id="kc-registration">
                <span>${msg("noAccount")} <a href="${url.registrationUrl}">${msg("doRegister")}</a></span>
            </div>
        </#if>
    <#elseif section = "socialProviders" >
        <#-- Rendered in the form section above. -->
    </#if>

</@layout.registrationLayout>
