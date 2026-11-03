from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(case_sensitive=False)

    database_url: str | None = None
    service_discoverer_url: str = "http://service-discoverer:8080"
    service_host: str | None = None
    port: int = 8080


settings = Settings()
