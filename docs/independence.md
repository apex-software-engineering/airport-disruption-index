# Independence policy

This policy says who operates the Airport Disruption Index, who can change it, and what those people
may trade. It exists so that anyone settling a contract on the index can check that its operator has
no stake in the outcome.

## Operator

The index is operated by **Apex Software Engineering LLC** (the operator). The operator writes and
runs the collector, publishes the methodology and the daily prints, and owns this site.

## Who can change the index

- Write access to the production deployment and its data store is limited to the operator's
  principals.
- The index is written only through its collector and settlement jobs: the collector records one
  round per slot, and settlement builds each day's print or a correction print, as the
  [methodology](methodology.md) describes. The jobs run on a schedule; the operator's principals may
  also run settlement or a correction manually.
- The source code is public. Anyone can read every change to it and recompute any round or print
  from the published archive (see [reproducing](methodology.md#reproducing)).
- A published print is changed only by a correction print, which names the print it supersedes and
  gives a reason. The original stays published (see [revisions](methodology.md#revisions)).

## Trading restrictions

The operator, its affiliates and their employees, every principal with write access to production,
the household members of all of these, and anyone who pitches or licenses the index on the
operator's behalf, do not trade, directly or through anyone else, any contract that references:

- the index or its sub-index (ADI, ADI-GS) or any value the site publishes; or
- a component of the index: the FAA ground stop or ground delay program status of a panel airport.

## Non-public information

The operator does not share information about the index that is not yet public, such as a collection
outage, a pending correction or an unannounced methodology change, with anyone who trades any
contract covered by the [trading restrictions](#trading-restrictions) (the index or any of its
components), before it is published.

## Methodology changes and source-adapter fixes

A **methodology change** is anything that changes what the index measures or how: a parameter, the
panel, or how events become airport-minutes. Methodology changes are versioned (see
[versioning](methodology.md#versioning)) and announced on the [incident log](incidents.md) at least
30 days before they take effect. A change never applies to a day that has already been printed.

A **source-adapter fix** reads the same FAA data from a new address or in a new shape, with the
formula and parameters unchanged. It is not a methodology change and ships without that notice. It
is announced on the [incident log](incidents.md) when it ships.

## Contact

Questions and reports about this policy:
[apexsoftwareengineeringllc@gmail.com](mailto:apexsoftwareengineeringllc@gmail.com). See also the
[contact page](https://airports.apexsofteng.com/contact).
