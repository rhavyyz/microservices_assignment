from fastapi import FastAPI

from app.api.routes.certificates import router

app = FastAPI(title="Certificates Service", version="0.1.0")
app.include_router(router)
