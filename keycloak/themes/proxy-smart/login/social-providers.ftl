<#--
  Override of keycloak.v2 social-providers.ftl to add custom IdP icons.

  How it works:
    - Keycloak.v2 uses <#switch p.providerId> for built-in providers (google, github, etc.)
    - Custom OIDC IdPs have providerId="oidc", so they fall to the default case.
    - We add a <#switch p.alias> BEFORE the providerId switch to match custom IdP aliases.
    - Unknown aliases fall through to the original providerId switch.

  To add a new custom IdP icon:
    1. Add a <#case "your-alias"> block in the alias switch below
    2. Add an inline SVG for the provider's logo
    3. Add corresponding CSS in resources/css/idp-icons.css

  showLabel: the "Or sign in with" band. login.ftl renders this block ABOVE the
  credentials form and passes false, where that wording would be wrong; every
  other caller (register.ftl and friends) keeps the default.
-->
<#macro show social showLabel=true>
  <#if showLabel>
    <div class="${properties.kcLoginMainFooterBand!}">
        <span class="${properties.kcLoginMainFooterBandItem!} ${properties.kcLoginMainFooterHelperText!}">
            ${msg("identity-provider-login-label")}
        </span>
    </div>
  </#if>
  <div id="kc-social-providers" class="${properties.kcFormSocialAccountSectionClass!}">
      <ul class="${properties.kcFormSocialAccountListClass!} <#if social.providers?size gt 3>${properties.kcFormSocialAccountListGridClass!}</#if>">
          <#list social.providers as p>
              <li class="<#if social.providers?size gt 3>${properties.kcFormSocialAccountGridItem!}<#else>${properties.kcFormSocialAccountListItemClass!}</#if>">
                  <a data-once-link
                     data-disabled-class="${properties.kcFormSocialAccountListButtonDisabledClass!}"
                     id="social-${p.alias}"
                     class="${properties.kcFormSocialAccountListButtonClass!}"
                     aria-label="${p.displayName}"
                     type="button"
                     href="${p.loginUrl}">
                      <#if p.iconClasses?has_content>
                          <span class="${p.iconClasses!}">${p.displayName!}</span>
                      <#else>
                          <#-- Custom IdP icons by alias -->
                          <#assign handled = false>
                          <#switch p.alias>
                              <#case "maxhealth">
                                  <#-- Max Health "M" logo — matches favicon.svg from maxhealth.tech -->
                                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                      <path d="M4 4h3l5 8 5-8h3v16h-3V9l-5 8-5-8v11H4V4z" fill="currentColor"/>
                                  </svg>
                                  <#assign handled = true>
                                  <#break>
                          </#switch>
                          <#if !handled>
                              <#-- Fall back to built-in provider icons by providerId -->
                              <#switch p.providerId>
                                  <#case "google">
                                      <svg viewBox="0 0 48 48" class="google" aria-hidden="true">
                                          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                                          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                                          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                                          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                                          <path fill="none" d="M0 0h48v48H0z"></path>
                                      </svg>
                                      <#break>
                                  <#case "github">
                                      <svg aria-hidden="true" viewBox="0 0 496 512">
                                          <path d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6-3.3.3-5.6-1.3-5.6-3.6 0-2 2.3-3.6 5.2-3.6 3-.3 5.6 1.3 5.6 3.6zm-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9 2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3zm44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9.3 2 2.9 3.3 5.9 2.6 2.9-.7 4.9-2.6 4.6-4.6-.3-1.9-3-3.2-5.9-2.9zM244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2 12.8 2.3 17.3-5.6 17.3-12.1 0-6.2-.3-40.4-.3-61.4 0 0-70 15-84.7-29.8 0 0-11.4-29.1-27.8-36.6 0 0-22.9-15.7 1.6-15.4 0 0 24.9 2 38.6 25.8 21.9 38.6 58.6 27.5 72.9 20.9 2.3-16 8.8-27.1 16-33.7-55.9-6.2-112.3-14.3-112.3-110.5 0-27.5 7.6-41.3 23.6-58.9-2.6-6.5-11.1-33.3 2.6-67.9 20.9-6.5 69 27 69 27 20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27 13.7 34.7 5.2 61.4 2.6 67.9 16 17.7 25.8 31.5 25.8 58.9 0 96.5-58.9 104.2-114.8 110.5 9.2 7.9 17 22.9 17 46.4 0 33.7-.3 75.4-.3 83.6 0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252 496 113.3 383.5 8 244.8 8z"/>
                                      </svg>
                                      <#break>
                                  <#case "facebook">
                                      <svg aria-hidden="true" viewBox="0 0 448 512">
                                          <path d="M448 56.7v398.5c0 13.7-11.1 24.7-24.7 24.7H309.1V306.5h58.2l8.7-67.6h-67v-43.2c0-19.6 5.4-32.9 33.5-32.9h35.8v-60.5c-6.2-.8-27.4-2.7-52.2-2.7-51.6 0-87 31.5-87 89.4v49.9h-58.4v67.6h58.4V480H24.7C11.1 480 0 468.9 0 455.3V56.7C0 43.1 11.1 32 24.7 32h398.5c13.7 0 24.8 11.1 24.8 24.7z"/>
                                      </svg>
                                      <#break>
                                  <#case "microsoft">
                                      <svg viewBox="0 0 448 512" aria-hidden="true">
                                          <path d="M0 32h214.6v214.6H0V32zm233.4 0H448v214.6H233.4V32zM0 265.4h214.6V480H0V265.4zm233.4 0H448V480H233.4V265.4z"></path>
                                      </svg>
                                      <#break>
                                  <#default>
                                      <svg viewBox="0 0 512 512" aria-hidden="true">
                                          <path d="M239.1 6.3l-208 78c-18.7 7-31.1 25-31.1 45v225.1c0 18.2 10.3 34.8 26.5 42.9l208 104c13.5 6.8 29.4 6.8 42.9 0l208-104c16.3-8.1 26.5-24.8 26.5-42.9V129.3c0-20-12.4-37.9-31.1-44.9l-208-78C262 2.2 250 2.2 239.1 6.3zM256 68.4l192 72v1.1l-192 78-192-78v-1.1l192-72zm32 356V275.5l160-65v133.9l-160 80z"/>
                                      </svg>
                              </#switch>
                          </#if>
                          <span class="${properties.kcFormSocialAccountNameClass!}">${p.displayName!}</span>
                      </#if>
                  </a>
              </li>
          </#list>
      </ul>
  </div>
</#macro>
