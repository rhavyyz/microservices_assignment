from discovery import Kind, register


def register_service() -> None:
    register(Kind.CERTIFICATES)
