import click

from .transform import build_report


@click.command(name="build")
def main() -> None:
    build_report()


if __name__ == "__main__":
    main()
