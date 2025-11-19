import { AuthPage } from "@refinedev/antd";

export const LoginPage = () => {
  return (
    <AuthPage
      type="login"
      title="Refine App"
      formProps={{
        initialValues: { username: "" },
      }}
      renderContent={(content: any, title: any) => (
        <div style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "100vh",
          backgroundColor: "#f0f2f5",
        }}>
          {title}
          {content}
        </div>
      )}
    />
  );
};
