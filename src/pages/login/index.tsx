import { AuthPage } from "@refinedev/antd";

/**
 * Страница входа в систему
 * Использует стандартный компонент AuthPage из Refine
 */
export const LoginPage: React.FC = () => {
  return (
    <AuthPage
      type="login"
      title={
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>
            ERP MebelKZ
          </h2>
          <p style={{ margin: "8px 0 0", color: "#8c8c8c", fontSize: 14 }}>
            Система управления производством
          </p>
        </div>
      }
      formProps={{
        initialValues: {
          username: "",
          password: "",
        },
      }}
    />
  );
};
