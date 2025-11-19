# Page snapshot

```yaml
- generic [ref=e7]:
  - heading "Sign in to your account" [level=3] [ref=e11]
  - generic [ref=e12]:
    - generic [ref=e13]:
      - generic [ref=e15]:
        - generic "Email" [ref=e17]
        - generic [ref=e18]:
          - textbox "Email" [ref=e21]: admin
          - alert [ref=e23]:
            - generic [ref=e24]: Invalid email address
      - generic [ref=e26]:
        - generic "Password" [ref=e28]
        - textbox "Password" [ref=e32]:
          - /placeholder: ●●●●●●●●
          - text: admin123
      - generic [ref=e33]:
        - generic [ref=e34] [cursor=pointer]:
          - checkbox "Remember me" [ref=e36]
          - generic [ref=e38]: Remember me
        - link "Forgot password?" [ref=e39] [cursor=pointer]:
          - /url: /forgot-password
      - button "Sign in" [active] [ref=e45] [cursor=pointer]:
        - generic [ref=e46]: Sign in
    - generic [ref=e48]:
      - text: Don’t have an account?
      - link "Sign up" [ref=e49] [cursor=pointer]:
        - /url: /register
```