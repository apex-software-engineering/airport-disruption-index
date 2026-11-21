# Independence policy

This policy says who operates the Airport Disruption Index, who can change it, and what those people
may trade. It exists so that anyone settling a contract on the index can check that its operator has
no stake in the outcome.

## Operator

The index is operated by **Apex Software Engineering LLC** (the operator). The operator writes and
runs the collector, publishes the methodology and the daily prints, and owns this site.

**TODO(Alex):** name the principals here, or keep them unnamed.

## Who can change the index

- Write access to the production deployment and its data store is limited to the operator's
  principals.
- Apart from a correction print (below), the index is written only by its scheduled jobs: the
  collector records one round per slot and the settlement job builds each day's print, as the
  [methodology](methodology.md) describes.
- The source code is public. Anyone can read every change to it and recompute any round or print
  from the published archive (see [reproducing](methodology.md#reproducing)).
- A published print is changed only by a correction print, which names the print it supersedes and
  gives a reason. The original stays published (see [revisions](methodology.md#revisions)).

## Trading restrictions

The operator, its affiliates and their employees, and anyone who pitches or licenses the index on
the operator's behalf, do not trade, directly or through anyone else, any contract that references:

- the index or its sub-index (ADI, ADI-GS) or any value the site publishes; or
- a component of the index: the FAA ground stop or ground delay program status of a panel airport.

**TODO(Alex):** confirm the scope of "components" above, and whether the restriction also covers
household members.

## Non-public information

The operator does not share information about the index that is not yet public, such as a collection
outage, a pending correction or an unannounced methodology change, with anyone who trades contracts
that reference the index, before it is published.

**TODO(Alex):** confirm this commitment.

## Methodology changes

Methodology changes are versioned (see [versioning](methodology.md#versioning)) and announced on
this site before they take effect. A change never applies to a day that has already been printed.

**TODO(Alex):** minimum notice period for a methodology change (for example 30 days), and where it
is announced.

## Contact

**TODO(Alex):** contact address for questions and reports about this policy (added by #17).
