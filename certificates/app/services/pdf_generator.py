
from datetime import date
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas


def generate_certificate_pdf(
    participant_name: str,
    event_name: str,
    event_date: date,
) -> bytes:
    """Generate a participation certificate and return its PDF bytes."""
    if not participant_name.strip():
        raise ValueError("Participant name must not be empty")

    if not event_name.strip():
        raise ValueError("Event name must not be empty")

    buffer = BytesIO()
    page_width, page_height = landscape(A4)

    pdf = canvas.Canvas(buffer, pagesize=(page_width, page_height))

    # Certificate border
    margin = 30
    pdf.setStrokeColor(colors.HexColor("#243B64"))
    pdf.setLineWidth(2)
    pdf.rect(
        margin,
        margin,
        page_width - 2 * margin,
        page_height - 2 * margin,
    )

    # Certificate title
    pdf.setFillColor(colors.HexColor("#243B64"))
    pdf.setFont("Helvetica-Bold", 28)
    pdf.drawCentredString(
        page_width / 2,
        page_height - 110,
        "CERTIFICATE OF PARTICIPATION",
    )

    # Main text
    pdf.setFillColor(colors.HexColor("#333333"))
    pdf.setFont("Helvetica", 16)
    pdf.drawCentredString(
        page_width / 2,
        page_height - 175,
        "This certificate is awarded to",
    )

    pdf.setFillColor(colors.HexColor("#243B64"))
    pdf.setFont("Helvetica-Bold", 24)
    pdf.drawCentredString(
        page_width / 2,
        page_height - 220,
        participant_name.strip(),
    )

    pdf.setFillColor(colors.HexColor("#333333"))
    pdf.setFont("Helvetica", 16)
    pdf.drawCentredString(
        page_width / 2,
        page_height - 270,
        "for participating in",
    )

    pdf.setFont("Helvetica-Bold", 20)
    pdf.drawCentredString(
        page_width / 2,
        page_height - 305,
        event_name.strip(),
    )

    pdf.setFont("Helvetica", 13)
    pdf.drawCentredString(
        page_width / 2,
        page_height - 345,
        f"Event date: {event_date.strftime('%B %d, %Y')}",
    )

    # Issuing date
    pdf.setFont("Helvetica", 10)
    pdf.drawCentredString(
        page_width / 2,
        65,
        f"Issued on {date.today().strftime('%B %d, %Y')}",
    )

    pdf.showPage()
    pdf.save()

    return buffer.getvalue()
