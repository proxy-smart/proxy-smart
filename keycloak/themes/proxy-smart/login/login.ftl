<#--
  Override of keycloak.v2 login.ftl (26.6.4) for one reason: the identity
  providers lead the card and the username/password form sits behind a
  disclosure under them.

  Keycloak's base template puts the social block in its own `socialProviders`
  section, which template.ftl renders after the card body — so the SSO button
  every clinician actually uses sat under the credentials form. The section is
  left empty here and the macro is called at the top of the form section
  instead, with the credentials form collapsed into a <details>.

  Native <details> rather than a script: the login page must work with
  JavaScript unavailable, and the element brings its own keyboard and
  screen-reader semantics.

  Everything inside credentialsForm is the base template verbatim, apart from
  the username autofocus, which is passed in — autofocus on a field inside a
  closed <details> focuses nothing.

  Re-diff against the base on a Keycloak upgrade.
-->
<#import "template.ftl" as layout>
<#import "field.ftl" as field>
<#import "buttons.ftl" as buttons>
<#import "social-providers.ftl" as identityProviders>
<#import "passkeys.ftl" as passkeys>

<#--
  The credentials form. In a macro because it renders in two places — bare when
  there is no identity provider to choose instead, inside the disclosure when
  there is — and writing it twice is how the two would drift apart.
-->
<#macro credentialsForm autofocusUsername>
    <div id="kc-form">
      <div id="kc-form-wrapper">
        <#if realm.password>
            <form id="kc-form-login" class="${properties.kcFormClass!}" onsubmit="login.disabled = true; return true;" action="${url.loginAction}" method="post" novalidate="novalidate">
                <#if !usernameHidden??>
                    <#assign label>
                        <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if>
                    </#assign>
                    <@field.input name="username" label=label error=messagesPerField.getFirstError('username','password')
                        autofocus=autofocusUsername autocomplete="${(enableWebAuthnConditionalUI?has_content)?then('username webauthn', 'username')}" value=login.username!'' />
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
</#macro>

<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=realm.password && realm.registrationAllowed && !registrationDisabled??; section>
<!-- template: login.ftl (proxy-smart) -->

    <#if section = "header">
        ${msg("loginAccountTitle")}
    <#elseif section = "form">
        <#assign hasSocialProviders = realm.password && social.providers?? && social.providers?has_content>

        <#--
          Open the disclosure whenever collapsing it would hide something the
          user needs: the inline error from a failed attempt (the global alert
          is suppressed for field errors), a username Keycloak already knows, a
          re-auth flow that only asks for the password, or passkey conditional
          UI, which needs the username field discoverable to offer a passkey.
        -->
        <#assign expandCredentials = messagesPerField.existsError('username','password')
            || usernameHidden??
            || enableWebAuthnConditionalUI?has_content
            || (login.username)?has_content>

        <#if hasSocialProviders>
            <#-- The wrapper is what the stylesheet keys off: the same
                 #kc-social-providers block still renders in the card footer on
                 other pages, and only this position needs different spacing. -->
            <div class="ps-login-social-top">
                <@identityProviders.show social=social showLabel=false/>
            </div>

            <#if realm.password>
                <details class="ps-password-disclosure"<#if expandCredentials> open</#if>>
                    <summary class="ps-password-summary">${msg("passwordSignInToggle")}</summary>
                    <@credentialsForm autofocusUsername=expandCredentials/>
                </details>
            </#if>
        <#else>
            <#-- Nothing to choose between, so no disclosure to open. -->
            <@credentialsForm autofocusUsername=true/>
        </#if>

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
