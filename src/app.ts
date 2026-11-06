import axios from "axios";
import { bootstrap } from "./tracker.ts";
import { logger } from "./logger.ts";
import { PORT, BASE_URL } from "./config.ts";

const axiosInstance = axios.create({
  headers: { Origin: BASE_URL },
  timeout: 5000,
});

const app = bootstrap(axiosInstance);

app.listen(PORT, () => {
  logger.info("Tracker is running", { url: BASE_URL });
});
