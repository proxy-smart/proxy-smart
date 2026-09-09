<#--
  Override of keycloak.v2 login.ftl (26.6.4) for one reason: the identity
  providers render ABOVE the username/password form, not below it.

  Keycloak's base template puts the social block in its own `socialProviders`
  section, which template.ftl renders after the card body — so the SSO button
  every clinician actually uses sat under the credentials form. The section is
  left empty here and the macro is called at the top of the form section
  instead.

  The "Or sign in with" band is suppressed in this position (showLabel=false):
  it reads as a footnote to the form, and above the button it is simply wrong.
  A hairline separates the two ways of signing in — no text, so no message key
  and nothing to translate.

  Everything else is the base template verbatim. Keep it that way, and re-diff
  against the base on a Keycloak upgrade.
-->
<#import "template.ftl" as layout>
<#import "field.ftl" as field>
<#import "buttons.ftl" as buttons>
<#import "social-providers.ftl" as identityProviders>
<#import "passkeys.ftl" as passkeys>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=realm.password && realm.registrationAllowed && !registrationDisabled??; section>
<!-- template: login.ftl (proxy-smart) -->

    <#if section = "header">
        ${msg("loginAccountTitle")}
    <#elseif section = "form">
        <#assign hasSocialProviders = realm.password && social.providers?? && social.providers?has_content>

        <#if hasSocialProviders>
            <#-- The wrapper is what the stylesheet keys off: the same
                 #kc-social-providers block still renders in the card footer on
                 other pages, and only this position needs different spacing. -->
            <div class="ps-login-social-top">
                <@identityProviders.show social=social showLabel=false/>
                <#if realm.password>
                    <div class="ps-login-separator" aria-hidden="true"></div>
                </#if>
            </div>
        </#if>

        <div id="kc-form">
          <div id="kc-form-wrapper">
            <#if realm.password>
                <form id="kc-form-login" class="${properties.kcFormClass!}" onsubmit="login.disabled = true; return true;" action="${url.loginAction}" method="post" novalidate="novalidate">
                    <#if !usernameHidden??>
                        <#assign label>
                            <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if>
                        </#assign>
                        <@field.input name="username" label=label error=messagesPerField.getFirstError('username','password')
                            autofocus=true autocomplete="${(enableWebAuthnConditionalUI?has_content)?then('username webauthn', 'username')}" value=login.username!'' />
                        <@field.password name="password" label=msg("password") error="" forgotPassword=realm.resetPasswordAllowed autofocus=usernameHidden?? autocomplete="current-password">
                            <#if realm.rememberMe && !usernameHidden??>
                                <@field.checkbox name="rememberMe" label=msg("rememberMe") value=login.rememberMe?? />
                            </#if>
                        </@field.password>
                    <#else>
                        <@field.password name="password" label=msg("password") forgotPassword=realm.resetPasswordAllowed autofocus=usernameHidden?? autocomplete="current-password">
                            <#if realm.rememberMe && !usernameHidden??>
                                <@field.checkbox name="rememberMe" label=msg("rememberMe") value=login.rememberMe?? />
                            </#if>
                        </@field.password>
                    </#if>

                    <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
                    <@buttons.loginButton />
                </form>
            </#if>
            </div>
        </div>
        <@passkeys.conditionalUIData />
    <#elseif section = "socialProviders" >
        <#-- Rendered in the form section above, so the card footer stays empty. -->
    <#elseif section = "info" >
        <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
            <div id="kc-registration-container">
                <div id="kc-registration">
                    <span>${msg("noAccount")} <a href="${url.registrationUrl}">${msg("doRegister")}</a></span>
                </div>
            </div>
        </#if>
    </#if>

</@layout.registrationLayout>
