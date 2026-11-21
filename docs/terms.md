# Terms of use

These terms cover the Airport Disruption Index website at https://airports.apexsofteng.com, its
public API under `/api/v1/`, and the index values, prints and receipts they publish. The index is
operated by Apex Software Engineering LLC ("we"). By using the site or the API you accept these
terms.

Effective date: 2026-11-22.

## The service

- The site and the API are free. No account or key is needed.
- Use them fairly. Automated clients should poll no faster than the index changes (one round per
  5-minute slot, as the [methodology](methodology.md#rounds-and-slots) describes) and send a
  User-Agent that identifies them. We may rate-limit or block traffic that degrades the service for
  others.
- We publish values and schedules as the [methodology](methodology.md) describes, including its
  coverage rules and settlement time. We make no other promise of availability, uptime or response
  time, and we may change or stop the service.

## Licences

- **Source code:** Apache License 2.0. The full text is in the repository's
  [LICENSE](https://github.com/apex-software-engineering/airport-disruption-index/blob/main/LICENSE)
  file.
- **Index values, prints and receipts:** Creative Commons Attribution 4.0 International
  ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). You may copy, redistribute and build
  on them, commercially or not, if you credit them as **"Airport Disruption Index by Apex Software
  Engineering LLC"** and say if you changed them.
- **FAA source data:** the FAA NAS Status feed, which we archive byte for byte, is a work of the US
  Government and is not subject to copyright in the US (17 U.S.C. 105). Our licence does not cover
  it and adds no restriction to it. See
  [sources](sources.md#faa-nas-status-airport-feed-settlement-source).

## No warranty

The site, the API and everything they publish are provided **"as is" and "as available"**, without
warranty of any kind, express or implied, including any warranty of accuracy, completeness, fitness
for a particular purpose or non-infringement. The index depends on a public FAA feed that can be
wrong, late or unavailable; the methodology says how such rounds are recorded. Read the
[disclaimer](disclaimer.md) before relying on the index.

## Limitation of liability

To the fullest extent the law allows, Apex Software Engineering LLC and its members, employees and
contractors are not liable for any loss or damage arising from use of, or inability to use, the
site, the API or the index, including trading or other financial losses.

## Independence

Who operates the index, who can change it, and what the operator may trade are set out in the
[independence policy](independence.md).

## Changes to these terms

We may update these terms. The current version is always on this page, and the repository's history
shows every past version.

## Contact

Email [apexsoftwareengineeringllc@gmail.com](mailto:apexsoftwareengineeringllc@gmail.com), or see
the [contact page](/contact).
