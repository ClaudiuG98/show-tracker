import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router";
import { App } from "../../src/ui/App";
import "@fontsource-variable/inter/wght.css";
import "../../src/ui/styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><HashRouter><App /></HashRouter></React.StrictMode>,
);
